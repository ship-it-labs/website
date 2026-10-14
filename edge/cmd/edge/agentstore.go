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

// agentUploader streams raw archive bytes to a server-agent's object store.
// No Supabase, no spool, no size-up-front: the part reader is handed to
// net/http as the PUT body and the agent hashes, caps and persists it,
// returning the key, hash and fetch ticket Node records.
// agentStorer is the agent-upload subset the ingest path needs, interfaced so
// the pipe-through is unit-testable without a network.
type agentStorer interface {
	Put(ctx context.Context, body io.Reader, contentType string) (*agentStoreResult, int, error)
}

type agentUploader struct {
	base   string
	secret string
	client *http.Client
	log    *slog.Logger
}

func newAgentUploader(agentURL, agentSecret string, log *slog.Logger) *agentUploader {
	if log == nil {
		log = slog.Default()
	}
	return &agentUploader{
		base:   strings.TrimRight(strings.TrimSpace(agentURL), "/"),
		secret: agentSecret,
		// No overall timeout: a 20GB body on a throttled link legitimately
		// takes a long time, and cancellation flows from the caller's context.
		client: &http.Client{},
		log:    log,
	}
}

type agentStoreResult struct {
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Ticket string `json:"ticket"`
}

// Put streams body to the agent and returns what it recorded plus the
// agent's HTTP status. A 413 means the object passed the agent's 20GB cap;
// anything else non-2xx (or a transport failure, status 0) is a 502 upstream.
func (a *agentUploader) Put(ctx context.Context, body io.Reader, contentType string) (*agentStoreResult, int, error) {
	// Generous but finite: a wedged agent connection must not hold an edge
	// worker past CI's own retry horizon. Normal uploads stream well under it.
	cctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPut, a.base+"/internal/store/put", body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Agent-Secret", a.secret)
	resp, err := a.client.Do(req)
	if err != nil {
		a.log.Error("agent store transport failed", "error", err, "agent", a.base)
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		a.log.Error("agent store rejected",
			"status", resp.StatusCode, "agent", a.base, "body", truncateStr(string(raw), 500))
		return nil, resp.StatusCode, fmt.Errorf("agent store: status %d", resp.StatusCode)
	}
	var res agentStoreResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("agent store: bad response: %w", err)
	}
	if res.Key == "" || res.Ticket == "" || res.Bytes <= 0 || res.SHA256 == "" {
		return nil, resp.StatusCode, fmt.Errorf("agent store: incomplete response")
	}
	return &res, resp.StatusCode, nil
}
