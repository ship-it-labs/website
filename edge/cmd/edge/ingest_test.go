package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// mockAgent implements the server-agent store endpoints: PUT streams the body
// to memory (hashing it) and answers with key/sha/ticket like the real host.
type mockAgent struct {
	t          *testing.T
	mu         sync.Mutex
	secret     string
	received   []byte
	puts       int
	cap        int64
	failStatus int
}

func (m *mockAgent) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/store/put", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if r.Header.Get("X-Agent-Secret") != m.secret {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"bad secret"}}`, http.StatusUnauthorized)
			return
		}
		if m.failStatus > 0 {
			http.Error(w, `{"error":{"code":"STORE_FAILED","message":"forced"}}`, m.failStatus)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, m.cap+1))
		if err != nil {
			http.Error(w, "unreadable", http.StatusBadRequest)
			return
		}
		if int64(len(body)) > m.cap {
			http.Error(w, `{"error":{"code":"OBJECT_TOO_LARGE","message":"object exceeds the limit"}}`, http.StatusRequestEntityTooLarge)
			return
		}
		m.received = body
		m.puts++
		sum := sha256.Sum256(body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"key":    "obj_test12345678.zip",
			"sha256": hex.EncodeToString(sum[:]),
			"bytes":  len(body),
			"ticket": "ticket-abc",
		})
	})
	return mux
}

// fakeAgent implements agentStorer without HTTP, for failure injection.
type fakeAgent struct {
	res *agentStoreResult
	err error
}

func (f *fakeAgent) Put(_ context.Context, _ io.Reader, _ string) (*agentStoreResult, int, error) {
	return f.res, 0, f.err
}

func testServerWithAgent(t *testing.T, agent agentStorer) *Server {
	t.Helper()
	return &Server{
		cfg:   Config{AgentStoreURL: "http://agent.test"},
		agent: agent,
		log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func newMultipartRequest(t *testing.T, fields map[string]string, fileFirst bool, fileField, filename string, fileBody []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	writeFields := func() {
		for k, v := range fields {
			if err := mw.WriteField(k, v); err != nil {
				t.Fatal(err)
			}
		}
	}
	writeFile := func() {
		if fileField == "" {
			return
		}
		fw, err := mw.CreateFormFile(fileField, filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(fileBody); err != nil {
			t.Fatal(err)
		}
	}
	if fileFirst {
		writeFile()
		writeFields()
	} else {
		writeFields()
		writeFile()
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// liveAgent runs a mockAgent over HTTP and returns a Server wired to it
// through the real agentUploader, so the pipe-through is exercised end to end.
func liveAgent(t *testing.T, cap int64) (*Server, *mockAgent) {
	t.Helper()
	mock := &mockAgent{t: t, secret: "s3cret", cap: cap}
	srv := httptest.NewServer(mock.handler())
	t.Cleanup(srv.Close)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Server{
		cfg:   Config{AgentStoreURL: srv.URL},
		agent: newAgentUploader(srv.URL, "s3cret", log),
		log:   log,
	}, mock
}

func TestStreamUploadToAgent(t *testing.T) {
	body := []byte("pretend this is a zip archive" + strings.Repeat("x", 1000))
	wantSHA := sha256.Sum256(body)
	fields := map[string]string{
		"project_id":   "my-app",
		"project_name": "My App",
		"run_command":  "npm start",
		"language":     "node",
		"env":          `{"A":"1"}`,
		"manifest":     `{"files":["a.js"],"total_bytes":2,"excluded":[]}`,
	}

	for _, fileFirst := range []bool{true, false} {
		srv, mock := liveAgent(t, 100<<20)
		req := newMultipartRequest(t, fields, fileFirst, "file", "archive.zip", body)
		res, ierr := srv.streamUploadToAgent(req.Context(), req, "UPLOAD_TOO_LARGE")
		if ierr != nil {
			t.Fatalf("fileFirst=%v: unexpected error: %v", fileFirst, ierr)
		}
		if res.sha256 != hex.EncodeToString(wantSHA[:]) {
			t.Errorf("fileFirst=%v: sha mismatch: %s", fileFirst, res.sha256)
		}
		if res.bytes != int64(len(body)) {
			t.Errorf("fileFirst=%v: bytes=%d want %d", fileFirst, res.bytes, len(body))
		}
		if res.agentKey != "obj_test12345678.zip" || res.ticket != "ticket-abc" {
			t.Errorf("fileFirst=%v: key/ticket not relayed: %+v", fileFirst, res)
		}
		if res.filename != "archive.zip" {
			t.Errorf("fileFirst=%v: filename=%q", fileFirst, res.filename)
		}
		for k, v := range fields {
			if res.fields[k] != v {
				t.Errorf("fileFirst=%v: field %q=%q want %q", fileFirst, k, res.fields[k], v)
			}
		}
		if !bytes.Equal(mock.received, body) {
			t.Errorf("fileFirst=%v: agent received %d bytes, want %d intact", fileFirst, len(mock.received), len(body))
		}
		if mock.puts != 1 {
			t.Errorf("fileFirst=%v: puts=%d want 1", fileFirst, mock.puts)
		}
	}
}

func TestStreamUploadAgentTooLarge(t *testing.T) {
	srv, _ := liveAgent(t, 10)
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "big.zip", []byte(strings.Repeat("z", 100)))
	_, ierr := srv.streamUploadToAgent(req.Context(), req, "BUNDLE_TOO_LARGE")
	if ierr == nil {
		t.Fatal("expected an error when the agent rejects oversize")
	}
	if ierr.status != 413 || ierr.code != "BUNDLE_TOO_LARGE" {
		t.Errorf("got %d/%s want 413/BUNDLE_TOO_LARGE", ierr.status, ierr.code)
	}
}

func TestStreamUploadAgentFailure(t *testing.T) {
	srv := testServerWithAgent(t, &fakeAgent{err: errors.New("agent down")})
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "a.zip", []byte("data"))
	_, ierr := srv.streamUploadToAgent(req.Context(), req, "UPLOAD_TOO_LARGE")
	if ierr == nil {
		t.Fatal("expected an error when the agent is unreachable")
	}
	if ierr.status != 502 {
		t.Errorf("status=%d want 502", ierr.status)
	}
}

func TestStreamUploadMissingFile(t *testing.T) {
	srv, mock := liveAgent(t, 100<<20)
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "", "", nil)
	_, ierr := srv.streamUploadToAgent(req.Context(), req, "UPLOAD_TOO_LARGE")
	if ierr == nil {
		t.Fatal("expected an error when no file part is present")
	}
	if ierr.status != 400 {
		t.Errorf("status=%d want 400", ierr.status)
	}
	if mock.puts != 0 {
		t.Errorf("agent must not be called without a file, got %d puts", mock.puts)
	}
}
