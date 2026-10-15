package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

// resolveTimeout bounds the home-agent lookup. It is a local indexed read;
// anything slower means Node is wedged, in which case the upload proceeds
// without a preference (orchestrator picks randomly) rather than stalling.
const resolveTimeout = 15 * time.Second

type homeAgent struct {
	AgentID  string `json:"agent_id"`
	AgentURL string `json:"agent_url"`
}

// resolveHomeAgent asks Node which host already holds this project's files.
// Empty strings mean "none recorded yet" (first upload, legacy row, or a
// database without the affinity columns) — the caller then omits the
// preference and the orchestrator picks randomly. Transport failures degrade
// the same way; only 401/404 (bad credential, unknown build) come back as
// errors, because those mean the upload itself must not proceed.
func (s *Server) resolveHomeAgent(ctx context.Context, kind, id, credential string) (homeAgent, *ingestError) {
	empty := homeAgent{}
	if id == "" {
		return empty, nil
	}
	var path string
	var payload map[string]any
	switch kind {
	case "project":
		if credential == "" {
			return empty, &ingestError{status: 401, code: "UNAUTHORIZED", message: "Missing credentials"}
		}
		path = "/internal/store-agent/project"
		payload = map[string]any{"authorization": credential, "project_id": id}
	case "bundle":
		if credential == "" {
			return empty, &ingestError{status: 401, code: "UNAUTHORIZED", message: "Invalid build report token"}
		}
		path = "/internal/store-agent/bundle"
		payload = map[string]any{"build_token": credential, "build_id": id}
	default:
		return empty, &ingestError{status: 500, code: "INTERNAL_ERROR", message: "Unknown resolve kind"}
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return empty, &ingestError{status: 500, code: "INTERNAL_ERROR", message: "Bad resolve request"}
	}
	cctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, s.cfg.UpstreamURL+path, bytes.NewReader(data))
	if err != nil {
		return empty, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-ingest-secret", s.cfg.IngestSecret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Node unreachable: degrade to random rather than refusing the bytes.
		// Finalize will fail later if Node is truly down, with its own 502.
		s.log.Warn("home-agent resolve transport failed; proceeding without preference", "error", err, "kind", kind)
		return empty, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		return empty, &ingestError{status: 401, code: "UNAUTHORIZED", message: "Invalid credentials"}
	}
	if resp.StatusCode == http.StatusNotFound {
		return empty, &ingestError{status: 404, code: "BUILD_NOT_FOUND", message: "Build not found"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		s.log.Warn("home-agent resolve failed; proceeding without preference",
			"status", resp.StatusCode, "kind", kind)
		return empty, nil
	}
	var out homeAgent
	if err := json.Unmarshal(raw, &out); err != nil {
		s.log.Warn("home-agent resolve bad body; proceeding without preference", "error", err)
		return empty, nil
	}
	return out, nil
}
