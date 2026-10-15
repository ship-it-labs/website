package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// TUS resumable uploads for objects too large for a single-shot POST.
// Supabase answers single uploads past its per-object cap with 413
// EntityTooLarge (seen live on CI bundles); the resumable endpoint accepts
// the same bytes as a sequence of offset-addressed chunks instead, with no
// practical size ceiling. RAM stays flat — one 6MB window — while the spooled
// disk file provides the re-readable source chunks require.

const tusResumableVersion = "1.0.0"

// tusChunkSize is the 6MB window Supabase documents for resumable uploads.
const tusChunkSize = 6 << 20

// tusUploader is the TUS subset the ingest path needs, interfaced so the
// size-branching is unit-testable without a network.
type tusUploader interface {
	uploadFile(ctx context.Context, bucket, objectPath string, f interface {
		ReadAt(p []byte, off int64) (int, error)
	}, size int64) error
}

type tusClient struct {
	base   string
	key    string
	http   *http.Client
	log    *slog.Logger
}

func newTusClient(supabaseURL, serviceKey string, log *slog.Logger) *tusClient {
	if log == nil {
		log = slog.Default()
	}
	return &tusClient{
		base: strings.TrimRight(strings.TrimSpace(supabaseURL), "/") + "/storage/v1",
		key:  serviceKey,
		http: &http.Client{},
		log:  log,
	}
}

func tusMetadata(bucket, objectPath, contentType string) string {
	enc := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	return "bucketName " + enc(bucket) +
		",objectName " + enc(objectPath) +
		",contentType " + enc(contentType) +
		",cacheControl " + enc("3600")
}

// createUpload opens a resumable session and returns the PATCH URL for chunks.
func (t *tusClient) createUpload(ctx context.Context, bucket, objectPath string, size int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+"/upload/resumable", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Tus-Resumable", tusResumableVersion)
	req.Header.Set("Upload-Length", strconv.FormatInt(size, 10))
	req.Header.Set("Upload-Metadata", tusMetadata(bucket, objectPath, "application/zip"))
	req.Header.Set("Authorization", "Bearer "+t.key)
	req.Header.Set("apikey", t.key)
	req.Header.Set("x-upsert", "true")

	resp, err := t.http.Do(req)
	if err != nil {
		t.log.Error("tus creation transport failed", "error", err, "bucket", bucket, "path", objectPath)
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusCreated {
		t.log.Error("tus creation rejected",
			"status", resp.StatusCode, "bucket", bucket, "path", objectPath, "body", truncateStr(string(raw), 500))
		return "", fmt.Errorf("tus creation: status %d", resp.StatusCode)
	}
	loc := strings.TrimSpace(resp.Header.Get("Location"))
	if loc == "" {
		return "", fmt.Errorf("tus creation: no Location header")
	}
	// Supabase returns an absolute URL, but resolve defensively in case a
	// self-hosted build answers relatively.
	if u, err := url.Parse(loc); err == nil && !u.IsAbs() {
		if base, berr := url.Parse(t.base + "/"); berr == nil {
			loc = base.ResolveReference(u).String()
		}
	}
	return loc, nil
}

// uploadChunk PATCHes one window at the given offset and returns the server's
// new offset, which is the only progress signal trusted (never assume).
func (t *tusClient) uploadChunk(ctx context.Context, uploadURL string, offset int64, chunk io.Reader, chunkSize int64) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, uploadURL, chunk)
	if err != nil {
		return offset, err
	}
	req.ContentLength = chunkSize
	req.Header.Set("Tus-Resumable", tusResumableVersion)
	req.Header.Set("Upload-Offset", strconv.FormatInt(offset, 10))
	req.Header.Set("Content-Type", "application/offset+octet-stream")
	req.Header.Set("Authorization", "Bearer "+t.key)
	req.Header.Set("apikey", t.key)

	resp, err := t.http.Do(req)
	if err != nil {
		return offset, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusNoContent {
		return offset, fmt.Errorf("tus chunk at offset %d: status %d", offset, resp.StatusCode)
	}
	next, err := strconv.ParseInt(strings.TrimSpace(resp.Header.Get("Upload-Offset")), 10, 64)
	if err != nil || next <= offset {
		return offset, fmt.Errorf("tus chunk at offset %d: bad next offset %q", offset, resp.Header.Get("Upload-Offset"))
	}
	return next, nil
}

// uploadFile streams a spooled file to bucket/path in 6MB windows. The file
// is re-seeked per window rather than read straight through so a retried
// window (future) starts from a known position; today any chunk error aborts
// and CI retries the whole upload.
func (t *tusClient) uploadFile(ctx context.Context, bucket, objectPath string, f interface {
	ReadAt(p []byte, off int64) (int, error)
}, size int64) error {
	uploadURL, err := t.createUpload(ctx, bucket, objectPath, size)
	if err != nil {
		return err
	}
	window := make([]byte, tusChunkSize)
	var offset int64
	for offset < size {
		want := tusChunkSize
		if remaining := size - offset; remaining < int64(want) {
			want = int(remaining)
		}
		n, err := f.ReadAt(window[:want], offset)
		if err != nil && err != io.EOF {
			return fmt.Errorf("tus spool read at offset %d: %w", offset, err)
		}
		if n == 0 {
			return fmt.Errorf("tus spool short read at offset %d of %d", offset, size)
		}
		next, err := t.uploadChunk(ctx, uploadURL, offset, bytes.NewReader(window[:n]), int64(n))
		if err != nil {
			t.log.Error("tus chunk failed",
				"error", err, "bucket", bucket, "path", objectPath, "offset", offset, "size", size)
			return err
		}
		offset = next
	}
	return nil
}
