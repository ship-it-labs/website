package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// mockTusServer implements just enough of the TUS protocol to verify the
// client: creation with metadata/length, then offset-checked chunk PATCHes.
// Anything out of order fails the request so protocol violations surface.
type mockTusServer struct {
	t          *testing.T
	mu         sync.Mutex
	data       []byte
	offset     int64
	creations  int
	chunks     int
	metadata   string
	upsert     string
	failCreate int
}

func (m *mockTusServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/storage/v1/upload/resumable", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if r.Header.Get("Tus-Resumable") != "1.0.0" {
			http.Error(w, "missing tus version", http.StatusBadRequest)
			return
		}
		if m.failCreate > 0 {
			m.failCreate--
			http.Error(w, "creation rejected", http.StatusInternalServerError)
			return
		}
		length, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
		if err != nil || length <= 0 {
			http.Error(w, "bad length", http.StatusBadRequest)
			return
		}
		m.metadata = r.Header.Get("Upload-Metadata")
		m.upsert = r.Header.Get("x-upsert")
		m.data = make([]byte, length)
		m.offset = 0
		m.creations++
		w.Header().Set("Location", "http://"+r.Host+"/storage/v1/upload/resumable/upload-id")
		w.WriteHeader(http.StatusCreated)
	})
	mux.HandleFunc("/storage/v1/upload/resumable/upload-id", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if r.Header.Get("Tus-Resumable") != "1.0.0" {
			http.Error(w, "missing tus version", http.StatusBadRequest)
			return
		}
		if r.Header.Get("Content-Type") != "application/offset+octet-stream" {
			http.Error(w, "bad content type", http.StatusBadRequest)
			return
		}
		off, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
		if err != nil || off != m.offset {
			http.Error(w, "offset mismatch", http.StatusConflict)
			return
		}
		chunk, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "unreadable", http.StatusBadRequest)
			return
		}
		if int64(len(chunk)) > int64(len(m.data))-m.offset {
			http.Error(w, "overrun", http.StatusBadRequest)
			return
		}
		copy(m.data[m.offset:], chunk)
		m.offset += int64(len(chunk))
		m.chunks++
		w.Header().Set("Upload-Offset", strconv.FormatInt(m.offset, 10))
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func TestTusUploadFile(t *testing.T) {
	// 14MB forces three windows (6+6+2) through the chunk loop.
	body := bytes.Repeat([]byte("abcdefgh"), 1750000)
	mock := &mockTusServer{t: t}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := newTusClient(srv.URL, "test-key", log)
	err := client.uploadFile(context.Background(), "project-uploads", "staging/stg_test.zip", bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("uploadFile failed: %v", err)
	}
	if mock.creations != 1 {
		t.Errorf("creations=%d want 1", mock.creations)
	}
	if mock.chunks != 3 {
		t.Errorf("chunks=%d want 3", mock.chunks)
	}
	if !bytes.Equal(mock.data, body) {
		t.Errorf("reassembled bytes differ (got %d, want %d)", len(mock.data), len(body))
	}
	// Metadata must name bucket, object, type and upsert so the object lands
	// where the finalize step expects it.
	meta := mock.metadata
	for _, want := range []string{
		"bucketName " + base64.StdEncoding.EncodeToString([]byte("project-uploads")),
		"objectName " + base64.StdEncoding.EncodeToString([]byte("staging/stg_test.zip")),
	} {
		if !strings.Contains(meta, want) {
			t.Errorf("metadata %q missing %q", meta, want)
		}
	}
	if mock.upsert != "true" {
		t.Errorf("x-upsert=%q want true", mock.upsert)
	}
}

func TestTusCreationRejected(t *testing.T) {
	mock := &mockTusServer{t: t, failCreate: 1}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := newTusClient(srv.URL, "test-key", log)
	err := client.uploadFile(context.Background(), "b", "staging/x.zip", bytes.NewReader([]byte("data")), 4)
	if err == nil {
		t.Fatal("expected an error when creation is rejected")
	}
}
