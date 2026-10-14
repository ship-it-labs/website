package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// objectStore is the slice of Supabase Storage the edge needs. Declared as an
// interface so the streaming path is unit-testable without a network.
type objectStore interface {
	Upload(ctx context.Context, bucket, path string, body io.Reader, contentType string) error
	Delete(ctx context.Context, bucket string, paths []string) error
}

// Storage streams objects to Supabase Storage over its REST API using the
// service-role key. Upload bodies are never buffered: the caller's reader is
// handed to net/http, which emits it chunked.
type Storage struct {
	base   string
	key    string
	client *http.Client
	log    *slog.Logger
}

func NewStorage(supabaseURL, serviceKey string, log *slog.Logger) *Storage {
	if log == nil {
		log = slog.Default()
	}
	return &Storage{
		base: strings.TrimRight(strings.TrimSpace(supabaseURL), "/") + "/storage/v1",
		key:  serviceKey,
		// Deliberately no Timeout: a 400MB body on a slow link legitimately
		// takes minutes, and cancellation flows from the caller's context.
		client: &http.Client{},
		log:    log,
	}
}

// escapeObjectPath escapes each path segment so object names with spaces or
// unicode survive, while the '/' separators stay intact.
func escapeObjectPath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

func (s *Storage) Upload(ctx context.Context, bucket, path string, body io.Reader, contentType string) error {
	u := s.base + "/object/" + url.PathEscape(bucket) + "/" + escapeObjectPath(path)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("Content-Type", contentType)
	// Staging names are unique per upload, so upsert is a no-op safety net,
	// not a licence to overwrite anyone's final object.
	req.Header.Set("x-upsert", "true")
	req.Header.Set("cache-control", "max-age=3600")
	resp, err := s.client.Do(req)
	if err != nil {
		// Transport failure (DNS, TLS, reset): logged here because the caller
		// only sees a 502 and the cause would otherwise be invisible.
		s.log.Error("storage upload transport failed", "error", err, "bucket", bucket, "path", path)
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Supabase's rejection body names the real problem (missing bucket,
		// RLS, quota, size cap). Logged server-side; the caller gets the
		// generic 502 so internals never leak to CI logs.
		s.log.Error("storage upload rejected",
			"status", resp.StatusCode, "bucket", bucket, "path", path, "body", truncateStr(string(raw), 500))
		return fmt.Errorf("storage upload: status %d", resp.StatusCode)
	}
	return nil
}

func (s *Storage) Delete(ctx context.Context, bucket string, paths []string) error {
	u := s.base + "/object/" + url.PathEscape(bucket)
	payload, err := json.Marshal(map[string]any{"prefixes": paths})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, u, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("storage delete: status %d", resp.StatusCode)
	}
	return nil
}
