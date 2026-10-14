package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"net/http"
	"time"
)

// stagingPrefix is where edge-streamed bytes land. Final paths stay exactly
// where the control plane always put them; only this throwaway prefix is new.
const stagingPrefix = "staging/"

// maxFieldBytes caps a single multipart text field. Fields are metadata, not
// content; a megabyte each is already generous, and an attacker stuffing
// gigabytes into `manifest` must not become a second buffering hole.
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
// the bytes: where they are, what they hash to, how big they are, and the
// small text fields that rode along in the same multipart body.
type uploadResult struct {
	stagingPath string
	sha256      string
	bytes       int64
	filename    string
	fields      map[string]string
}

// countingHasher feeds a sha256 and a byte counter from a single Read pass,
// so one streaming pass yields both the integrity hash and the size with no
// second scan and no buffer.
type countingHasher struct {
	r io.Reader
	h hash.Hash
	n int64
}

func (c *countingHasher) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.h.Write(p[:n])
		c.n += int64(n)
	}
	return n, err
}

// newStagingID mints a unique staging object name. Unpredictable on purpose:
// staging paths must not be guessable by another tenant's finalize call.
func newStagingID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("stg_%d", time.Now().UnixNano())
	}
	return "stg_" + hex.EncodeToString(b[:])
}

// streamUploadToStaging reads a multipart body part by part, streaming the
// single `file` part straight into object storage while hashing it, and
// collecting the small text fields. Peak extra memory is a few kilobytes of
// pipe buffers regardless of archive size — this is the OOM fix.
func streamUploadToStaging(
	ctx context.Context,
	store objectStore,
	bucket string,
	r *http.Request,
	maxBytes int64,
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

		staging := stagingPrefix + newStagingID() + ".zip"
		ch := &countingHasher{r: part, h: sha256.New()}
		// maxBytes+1, not maxBytes: an oversize body must be *detected* and
		// rejected with 413, not silently truncated to exactly the limit.
		body := io.LimitReader(ch, maxBytes+1)
		if err := store.Upload(ctx, bucket, staging, body, "application/zip"); err != nil {
			return nil, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload"}
		}
		res.stagingPath = staging
		res.sha256 = hex.EncodeToString(ch.h.Sum(nil))
		res.bytes = ch.n

		if ch.n > maxBytes {
			// Best effort: the sweeper reaps anything left behind, but leaving
			// a known-abandoned 400MB object to the sweeper is sloppy.
			_ = store.Delete(context.WithoutCancel(ctx), bucket, []string{staging})
			return nil, &ingestError{
				status:  413,
				code:    "UPLOAD_TOO_LARGE",
				message: fmt.Sprintf("Upload exceeds the %dMB limit", maxBytes/1024/1024),
			}
		}
		if ch.n == 0 {
			_ = store.Delete(context.WithoutCancel(ctx), bucket, []string{staging})
			return nil, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "file is required"}
		}
	}
	if res.stagingPath == "" {
		return nil, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "file is required"}
	}
	return res, nil
}
