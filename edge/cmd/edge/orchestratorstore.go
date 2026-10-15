package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// orchestratorUploader streams raw archive bytes to the orchestrator's store
// endpoint, which picks the storing host (random healthy, or the preferred
// home) and pipes the bytes through to it. The edge holds no agent addresses
// and no agent secret: it authenticates to the orchestrator with the service
// secret it already uses for everything else, and the orchestrator — which
// owns the agent registry and their secret — does the rest.
//
// No spool, no size-up-front: the multipart part reader is the PUT body and
// RAM stays flat. The 20GB cap lives on the storing agent, which answers 413
// past it; the orchestrator relays that status so the edge relays it too.
type orchestratorUploader struct {
	base   string
	secret string
	client *http.Client
	log    *slog.Logger
}

func newOrchestratorUploader(orchestratorURL, orchestratorSecret string, log *slog.Logger) *orchestratorUploader {
	if log == nil {
		log = slog.Default()
	}
	return &orchestratorUploader{
		base:   strings.TrimRight(strings.TrimSpace(orchestratorURL), "/"),
		secret: orchestratorSecret,
		// No overall timeout: a 20GB body on a throttled link legitimately
		// takes a long time, and cancellation flows from the caller's context.
		client: &http.Client{},
		log:    log,
	}
}

// orchestratorStoreResult is what the orchestrator answers: where the bytes
// landed and how to fetch them back.
type orchestratorStoreResult struct {
	AgentID  string `json:"agent_id"`
	AgentURL string `json:"agent_url"`
	Key      string `json:"key"`
	SHA256   string `json:"sha256"`
	Bytes    int64  `json:"bytes"`
	Ticket   string `json:"ticket"`
}

// storeStorer is the upload subset the ingest path needs, interfaced so the
// pipe-through is unit-testable without a network.
type storeStorer interface {
	Put(ctx context.Context, body io.Reader, preferredAgentURL string) (*orchestratorStoreResult, int, error)
}

// Put pipes body to the orchestrator, naming the preferred home host when the
// project already has one (empty means "pick randomly"). Returns the receipt
// and the orchestrator's HTTP status: 413 past the cap, 503 with no agents,
// anything else non-2xx (or transport failure, status 0) as a 502 upstream.
func (o *orchestratorUploader) Put(ctx context.Context, body io.Reader, preferredAgentURL string) (*orchestratorStoreResult, int, error) {
	// Generous but finite: a wedged connection must not hold an edge worker
	// past CI's own retry horizon. Normal uploads stream well under it.
	cctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPut, o.base+"/store/put", body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/zip")
	req.Header.Set("X-Service-Secret", o.secret)
	if strings.TrimSpace(preferredAgentURL) != "" {
		req.Header.Set("X-Preferred-Agent", strings.TrimSpace(preferredAgentURL))
	}
	resp, err := o.client.Do(req)
	if err != nil {
		o.log.Error("store forward transport failed", "error", err, "orchestrator", o.base)
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		o.log.Error("store forward rejected",
			"status", resp.StatusCode, "orchestrator", o.base, "body", truncateStr(string(raw), 500))
		return nil, resp.StatusCode, fmt.Errorf("store forward: status %d", resp.StatusCode)
	}
	var res orchestratorStoreResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("store forward: bad response: %w", err)
	}
	if res.AgentURL == "" || res.Key == "" || res.Ticket == "" || res.Bytes <= 0 || res.SHA256 == "" {
		return nil, resp.StatusCode, fmt.Errorf("store forward: incomplete response")
	}
	return &res, resp.StatusCode, nil
}
