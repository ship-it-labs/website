package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// mockOrchestrator implements the orchestrator store endpoint: it checks the
// service secret, records the preferred header, streams the body (hashing
// it), and answers with a receipt like the real forwarder.
type mockOrchestrator struct {
	t            *testing.T
	mu           sync.Mutex
	secret       string
	received     []byte
	preferred    []string
	puts         int
	cap          int64
	failStatus   int
	agentID      string
	agentURL     string
	key          string
	ticket       string
}

func (m *mockOrchestrator) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/store/put", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if r.Header.Get("X-Service-Secret") != m.secret {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"bad secret"}}`, http.StatusUnauthorized)
			return
		}
		m.preferred = append(m.preferred, r.Header.Get("X-Preferred-Agent"))
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
			http.Error(w, `{"error":{"code":"OBJECT_TOO_LARGE","message":"too large"}}`, http.StatusRequestEntityTooLarge)
			return
		}
		m.received = body
		m.puts++
		sum := sha256.Sum256(body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agent_id":  m.agentID,
			"agent_url": m.agentURL,
			"key":       m.key,
			"sha256":    hex.EncodeToString(sum[:]),
			"bytes":     len(body),
			"ticket":    m.ticket,
		})
	})
	return mux
}

// mockNodeResolve answers the home-agent lookup with a fixed home (possibly
// empty), proving the edge forwards the preference.
type mockNodeResolve struct {
	agentID  string
	agentURL string
	calls    int
	mu       sync.Mutex
}

func (m *mockNodeResolve) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/store-agent/project", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agent_id":  m.agentID,
			"agent_url": m.agentURL,
		})
	})
	mux.HandleFunc("/internal/store-agent/bundle", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"agent_id":  m.agentID,
			"agent_url": m.agentURL,
		})
	})
	return mux
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

// liveStack wires a Server to a mock orchestrator (real uploader). Node
// resolve is bypassed by calling streamUploadToAgent directly with an
// explicit preference; resolveHomeAgent is tested separately below.
func liveStack(t *testing.T, cap int64) (*Server, *mockOrchestrator) {
	t.Helper()
	mock := &mockOrchestrator{
		t: t, secret: "svc-secret", cap: cap,
		agentID: "agent-1", agentURL: "http://agent-1.test",
		key: "obj_test12345678.zip", ticket: "ticket-abc",
	}
	srv := httptest.NewServer(mock.handler())
	t.Cleanup(srv.Close)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &Server{
		cfg:  Config{OrchestratorURL: srv.URL},
		orch: newOrchestratorUploader(srv.URL, "svc-secret", log),
		log:  log,
	}, mock
}

func TestStreamUploadToAgent(t *testing.T) {
	body := []byte("pretend this is a zip archive" + strings.Repeat("x", 1000))
	wantSHA := sha256.Sum256(body)
	fields := map[string]string{
		"project_id":   "my-app",
		"project_name": "My App",
	}

	for _, fileFirst := range []bool{true, false} {
		srv, mock := liveStack(t, 100<<20)
		req := newMultipartRequest(t, fields, fileFirst, "file", "archive.zip", body)
		res, ierr := srv.streamUploadToAgent(req.Context(), req, "http://preferred.test", "UPLOAD_TOO_LARGE")
		if ierr != nil {
			t.Fatalf("fileFirst=%v: unexpected error: %v", fileFirst, ierr)
		}
		if res.sha256 != hex.EncodeToString(wantSHA[:]) {
			t.Errorf("fileFirst=%v: sha mismatch", fileFirst)
		}
		if res.bytes != int64(len(body)) {
			t.Errorf("fileFirst=%v: bytes=%d want %d", fileFirst, res.bytes, len(body))
		}
		if res.agentID != "agent-1" || res.agentURL != "http://agent-1.test" {
			t.Errorf("fileFirst=%v: agent not relayed: %+v", fileFirst, res)
		}
		if res.agentKey != "obj_test12345678.zip" || res.ticket != "ticket-abc" {
			t.Errorf("fileFirst=%v: key/ticket not relayed", fileFirst)
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
			t.Errorf("fileFirst=%v: orchestrator received %d bytes, want %d intact", fileFirst, len(mock.received), len(body))
		}
		if len(mock.preferred) != 1 || mock.preferred[0] != "http://preferred.test" {
			t.Errorf("fileFirst=%v: preferred header %v", fileFirst, mock.preferred)
		}
	}
}

func TestStreamUploadTooLarge(t *testing.T) {
	srv, _ := liveStack(t, 10)
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "big.zip", []byte(strings.Repeat("z", 100)))
	_, ierr := srv.streamUploadToAgent(req.Context(), req, "", "BUNDLE_TOO_LARGE")
	if ierr == nil {
		t.Fatal("expected an error when the store rejects oversize")
	}
	if ierr.status != 413 || ierr.code != "BUNDLE_TOO_LARGE" {
		t.Errorf("got %d/%s want 413/BUNDLE_TOO_LARGE", ierr.status, ierr.code)
	}
}

func TestStreamUploadStoreFailure(t *testing.T) {
	srv, mock := liveStack(t, 100<<20)
	mock.failStatus = http.StatusBadGateway
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "a.zip", []byte("data"))
	_, ierr := srv.streamUploadToAgent(req.Context(), req, "", "UPLOAD_TOO_LARGE")
	if ierr == nil {
		t.Fatal("expected an error when the store fails")
	}
	if ierr.status != 502 {
		t.Errorf("status=%d want 502", ierr.status)
	}
}

func TestStreamUploadMissingFile(t *testing.T) {
	srv, _ := liveStack(t, 100<<20)
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "", "", nil)
	_, ierr := srv.streamUploadToAgent(req.Context(), req, "", "UPLOAD_TOO_LARGE")
	if ierr == nil {
		t.Fatal("expected an error when no file part is present")
	}
	if ierr.status != 400 {
		t.Errorf("status=%d want 400", ierr.status)
	}
}

func TestResolveHomeAgent(t *testing.T) {
	node := &mockNodeResolve{agentID: "agent-9", agentURL: "http://agent-9.test"}
	srv := httptest.NewServer(node.handler())
	defer srv.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &Server{
		cfg: Config{UpstreamURL: srv.URL, IngestSecret: "s3cret"},
		log: log,
	}
	// Project resolve forwards the bearer credential.
	home, ierr := s.resolveHomeAgent(t.Context(), "project", "my-app", "Bearer ox_live_123")
	if ierr != nil {
		t.Fatalf("unexpected error: %v", ierr)
	}
	if home.AgentID != "agent-9" || home.AgentURL != "http://agent-9.test" {
		t.Errorf("wrong home: %+v", home)
	}
	// Bundle resolve forwards the build token.
	home, ierr = s.resolveHomeAgent(t.Context(), "bundle", "build_1", "token-xyz")
	if ierr != nil {
		t.Fatalf("unexpected error: %v", ierr)
	}
	if home.AgentID != "agent-9" {
		t.Errorf("wrong home: %+v", home)
	}
	if node.calls != 2 {
		t.Errorf("calls=%d want 2", node.calls)
	}
	// Missing credential fails fast (no anonymous resolve).
	if _, ierr := s.resolveHomeAgent(t.Context(), "project", "my-app", ""); ierr == nil {
		t.Error("expected an error without credentials")
	}
}
