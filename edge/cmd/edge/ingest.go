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
	"os"
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

// singleShotMaxBytes is the largest object sent as one POST. Past this,
// Supabase answers 413 EntityTooLarge, so bigger bodies go up by TUS chunks
// instead. 32MB sits safely under the single-shot cap with margin. A var (not
// const) so tests can force the TUS branch without 32MB fixtures.
var singleShotMaxBytes = int64(32 << 20)

// streamUploadToStaging reads a multipart body part by part, spooling the
// single `file` part to a temp disk file (never RAM) while hashing it, then
// storing it: one POST for small objects, TUS chunks for large ones. Peak
// extra memory is kilobytes of buffers plus one 6MB TUS window regardless of
// archive size — this is the OOM fix — and disk holds at most one transient
// spool, removed before the response is written.
func (s *Server) streamUploadToStaging(
	ctx context.Context,
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

		// Spool to disk for sizing: TUS creation needs the total up front,
		// and chunk PATCHes need a re-readable source. RAM never holds the
		// body; the temp file is removed on every path below.
		tmp, err := os.CreateTemp("", "shipit-upload-*.zip")
		if err != nil {
			s.log.Error("upload spool failed", "error", err)
			return nil, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload"}
		}
		dropSpool := func() {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
		ch := &countingHasher{r: part, h: sha256.New()}
		// maxBytes+1, not maxBytes: an oversize body must be *detected* and
		// rejected with 413, not silently truncated to exactly the limit.
		if _, err := io.Copy(tmp, io.LimitReader(ch, maxBytes+1)); err != nil {
			dropSpool()
			return nil, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload"}
		}
		size := ch.n
		sha := hex.EncodeToString(ch.h.Sum(nil))

		if size > maxBytes {
			dropSpool()
			return nil, &ingestError{
				status:  413,
				code:    "UPLOAD_TOO_LARGE",
				message: fmt.Sprintf("Upload exceeds the %dMB limit", maxBytes/1024/1024),
			}
		}
		if size == 0 {
			dropSpool()
			return nil, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "file is required"}
		}

		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			dropSpool()
			return nil, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload"}
		}
		var storeErr error
		if size <= singleShotMaxBytes {
			storeErr = s.store.Upload(ctx, bucket, staging, tmp, "application/zip", size)
		} else {
			s.log.Info("large upload, switching to TUS",
				"bucket", bucket, "staging", staging, "bytes", size)
			storeErr = s.tus.uploadFile(ctx, bucket, staging, tmp, size)
		}
		dropSpool()
		if storeErr != nil {
			return nil, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to store the upload"}
		}
		res.stagingPath = staging
		res.sha256 = sha
		res.bytes = size
	}
	if res.stagingPath == "" {
		return nil, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "file is required"}
	}
	return res, nil
}
