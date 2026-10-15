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

// maxFieldBytes caps a single multipart text field. Fields are metadata, not
// content; a megabyte each is already generous, and an attacker stuffing
// gigabytes into `manifest` must not become a buffering hole.
const maxFieldBytes = 1 << 20

// ingestError is the edge's analogue of the control plane's error envelope so
// plugin and CI callers see the same shape whichever layer rejects them.
type ingestError struct {
	status  int
	code    string
	message string
}

func (e *ingestError) Error() string { return e.code + ": " + e.message }

func writeIngestError(w http.ResponseWriter, e *ingestError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	raw, _ := json.Marshal(map[string]any{
		"error": map[string]string{"code": e.code, "message": e.message},
	})
	_, _ = w.Write(raw)
}

// uploadResult carries everything Node needs to finalize without ever seeing
// the bytes: where the agent stored them, their hash and size, the fetch
// ticket, and the small text fields that rode along in the same multipart
// body.
type uploadResult struct {
	agentKey string
	ticket   string
	sha256   string
	bytes    int64
	filename string
	fields   map[string]string
}

// streamUploadToAgent reads a multipart body part by part, piping the single
// `file` part straight through to the server-agent's object store and
// collecting the small text fields. No spool, no buffer, no size-up-front:
// the part reader is the PUT body, RAM stays flat, and the 20GB cap is
// enforced authoritatively by the agent (which answers 413 past it).
func (s *Server) streamUploadToAgent(
	ctx context.Context,
	r *http.Request,
	tooLargeCode string,
) (*uploadResult, *ingestError) {
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, &ingestError{status: 400, code: "INVALID_UPLOAD", message: "Expected a multipart upload"}
	}
	res := &uploadResult{fields: map[string]string{}}
	fileSeen := false

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, &ingestError{status: 400, code: "INVALID_UPLOAD", message: "Could not read the upload"}
		}
		name := part.FormName()

		// Anything that is not the `file` field is metadata. Read it (bounded)
		// and drain any remainder so the connection stays in sync; a smuggled
		// second archive under another field name ends up discarded, never
		// buffered.
		if name != "file" {
			v, _ := io.ReadAll(io.LimitReader(part, maxFieldBytes))
			_, _ = io.Copy(io.Discard, part)
			if name != "" {
				res.fields[name] = string(v)
			}
			continue
		}
		if fileSeen {
			_, _ = io.Copy(io.Discard, part)
			continue
		}
		fileSeen = true
		if fn := part.FileName(); fn != "" {
			res.filename = fn
		}

		stored, agentStatus, err := s.agent.Put(ctx, part, "application/zip")
		if err != nil {
			if agentStatus == http.StatusRequestEntityTooLarge {
				return nil, &ingestError{
					status:  413,
					code:    tooLargeCode,
					message: "Upload exceeds the 20GB limit",
				}
			}
			return nil, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload"}
		}
		if stored.Bytes == 0 {
			return nil, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "file is required"}
		}
		res.agentKey = stored.Key
		res.ticket = stored.Ticket
		res.sha256 = stored.SHA256
		res.bytes = stored.Bytes
	}
	_ = fileSeen

	if res.agentKey == "" {
		return nil, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "file is required"}
	}
	return res, nil
}

// finalizeTimeout bounds the Node-side finalize call. Identity, crypto and a
// few indexed writes take seconds; five minutes covers a cold database without
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
