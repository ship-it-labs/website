package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// finalizeTimeout bounds the Node-side finalize call. Copy, sign and a few
// indexed writes take seconds; five minutes covers a cold database without
// letting a wedged upstream hold an edge worker forever.
const finalizeTimeout = 5 * time.Minute

// finalizeResponse is the envelope the control plane's internal ingest routes
// return: the status the public caller should see and the exact body bytes to
// relay, so the wire contract stays byte-identical to a direct Node upload.
type finalizeResponse struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

func callFinalize(ctx context.Context, upstream, secret, path string, payload any) (int, []byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, finalizeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodPost, upstream+path, bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-ingest-secret", secret)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	// Finalize replies are metadata, never content: an 8MB ceiling is ample
	// and stops a compromised upstream from drowning the edge in reply bytes.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return 0, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, nil, fmt.Errorf("finalize %s: status %d: %s", path, resp.StatusCode, truncateStr(string(raw), 300))
	}
	var fr finalizeResponse
	if err := json.Unmarshal(raw, &fr); err != nil {
		return 0, nil, fmt.Errorf("finalize %s: bad envelope: %w", path, err)
	}
	if fr.Status <= 0 {
		fr.Status = 200
	}
	if len(fr.Body) == 0 {
		fr.Body = []byte("{}")
	}
	return fr.Status, fr.Body, nil
}

func truncateStr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
