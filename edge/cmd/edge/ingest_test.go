package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeStore records single-shot uploads without touching the network.
type fakeStore struct {
	uploaded   map[string][]byte
	sizes      map[string]int64
	failUpload bool
}

func (f *fakeStore) Upload(_ context.Context, _ string, path string, body io.Reader, _ string, size int64) error {
	if f.failUpload {
		return errors.New("boom")
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if size != int64(len(data)) {
		return errors.New("declared size does not match streamed bytes")
	}
	if f.uploaded == nil {
		f.uploaded = map[string][]byte{}
		f.sizes = map[string]int64{}
	}
	f.uploaded[path] = data
	f.sizes[path] = size
	return nil
}

func (f *fakeStore) Delete(_ context.Context, _ string, _ []string) error {
	return nil
}

// fakeTus records resumable uploads; it reads through the ReadAt interface
// exactly as the production client does, so chunking is exercised.
type tusCall struct {
	bucket string
	path   string
	size   int64
}

type fakeTus struct {
	calls  []tusCall
	stored map[string][]byte
	fail   bool
}

func (f *fakeTus) uploadFile(_ context.Context, bucket, path string, r interface {
	ReadAt(p []byte, off int64) (int, error)
}, size int64) error {
	if f.fail {
		return errors.New("tus boom")
	}
	f.calls = append(f.calls, tusCall{bucket, path, size})
	buf := make([]byte, size)
	var off int64
	for off < size {
		n, err := r.ReadAt(buf[off:], off)
		off += int64(n)
		if err != nil && err != io.EOF {
			return err
		}
		if n == 0 {
			break
		}
	}
	if off != size {
		return errors.New("short spool read")
	}
	if f.stored == nil {
		f.stored = map[string][]byte{}
	}
	f.stored[path] = buf
	return nil
}

func testServer(store *fakeStore, tus *fakeTus) *Server {
	return &Server{
		store: store,
		tus:   tus,
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

func TestStreamUploadToStaging(t *testing.T) {
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
		store := &fakeStore{}
		srv := testServer(store, &fakeTus{})
		req := newMultipartRequest(t, fields, fileFirst, "file", "archive.zip", body)
		res, ierr := srv.streamUploadToStaging(req.Context(), "project-uploads", req, 400*1024*1024)
		if ierr != nil {
			t.Fatalf("fileFirst=%v: unexpected error: %v", fileFirst, ierr)
		}
		if res.sha256 != hex.EncodeToString(wantSHA[:]) {
			t.Errorf("fileFirst=%v: sha mismatch: %s", fileFirst, res.sha256)
		}
		if res.bytes != int64(len(body)) {
			t.Errorf("fileFirst=%v: bytes=%d want %d", fileFirst, res.bytes, len(body))
		}
		if res.filename != "archive.zip" {
			t.Errorf("fileFirst=%v: filename=%q", fileFirst, res.filename)
		}
		if !strings.HasPrefix(res.stagingPath, "staging/") || !strings.HasSuffix(res.stagingPath, ".zip") {
			t.Errorf("fileFirst=%v: bad staging path %q", fileFirst, res.stagingPath)
		}
		for k, v := range fields {
			if res.fields[k] != v {
				t.Errorf("fileFirst=%v: field %q=%q want %q", fileFirst, k, res.fields[k], v)
			}
		}
		stored, ok := store.uploaded[res.stagingPath]
		if !ok {
			t.Fatalf("fileFirst=%v: nothing stored at %q", fileFirst, res.stagingPath)
		}
		if !bytes.Equal(stored, body) {
			t.Errorf("fileFirst=%v: stored bytes differ", fileFirst)
		}
		if store.sizes[res.stagingPath] != int64(len(body)) {
			t.Errorf("fileFirst=%v: declared size %d want %d", fileFirst, store.sizes[res.stagingPath], len(body))
		}
	}
}

func TestStreamUploadUsesTusAboveThreshold(t *testing.T) {
	old := singleShotMaxBytes
	singleShotMaxBytes = 10
	defer func() { singleShotMaxBytes = old }()

	body := []byte(strings.Repeat("z", 100))
	wantSHA := sha256.Sum256(body)
	store := &fakeStore{}
	tus := &fakeTus{}
	srv := testServer(store, tus)
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "big.zip", body)
	res, ierr := srv.streamUploadToStaging(req.Context(), "project-uploads", req, 400*1024*1024)
	if ierr != nil {
		t.Fatalf("unexpected error: %v", ierr)
	}
	if len(store.uploaded) != 0 {
		t.Errorf("large body must not use single-shot POST: %v", store.uploaded)
	}
	if len(tus.calls) != 1 {
		t.Fatalf("expected one TUS upload, got %d", len(tus.calls))
	}
	call := tus.calls[0]
	if call.bucket != "project-uploads" || call.size != int64(len(body)) {
		t.Errorf("wrong TUS call: %+v", call)
	}
	if res.stagingPath != call.path {
		t.Errorf("staging path %q != TUS path %q", res.stagingPath, call.path)
	}
	if res.sha256 != hex.EncodeToString(wantSHA[:]) || res.bytes != int64(len(body)) {
		t.Errorf("wrong hash/size: %+v", res)
	}
	if !bytes.Equal(tus.stored[call.path], body) {
		t.Errorf("TUS-stored bytes differ")
	}
}

func TestStreamUploadTusFailure(t *testing.T) {
	old := singleShotMaxBytes
	singleShotMaxBytes = 10
	defer func() { singleShotMaxBytes = old }()

	store := &fakeStore{}
	tus := &fakeTus{fail: true}
	srv := testServer(store, tus)
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "big.zip", []byte(strings.Repeat("z", 100)))
	_, ierr := srv.streamUploadToStaging(req.Context(), "project-uploads", req, 400*1024*1024)
	if ierr == nil {
		t.Fatal("expected an error when TUS fails")
	}
	if ierr.status != 502 {
		t.Errorf("status=%d want 502", ierr.status)
	}
}

func TestStreamUploadTooLarge(t *testing.T) {
	body := []byte(strings.Repeat("y", 100))
	store := &fakeStore{}
	srv := testServer(store, &fakeTus{})
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "a.zip", body)
	_, ierr := srv.streamUploadToStaging(req.Context(), "project-uploads", req, 10)
	if ierr == nil {
		t.Fatal("expected an error for an oversize body")
	}
	if ierr.status != 413 {
		t.Errorf("status=%d want 413", ierr.status)
	}
	// Rejection happens while spooling locally, before any storage call.
	if len(store.uploaded) != 0 {
		t.Errorf("oversize body must never reach storage: %v", store.uploaded)
	}
}

func TestStreamUploadMissingFile(t *testing.T) {
	srv := testServer(&fakeStore{}, &fakeTus{})
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "", "", nil)
	_, ierr := srv.streamUploadToStaging(req.Context(), "project-uploads", req, 400*1024*1024)
	if ierr == nil {
		t.Fatal("expected an error when no file part is present")
	}
	if ierr.status != 400 {
		t.Errorf("status=%d want 400", ierr.status)
	}
}

func TestStreamUploadStorageFailure(t *testing.T) {
	store := &fakeStore{failUpload: true}
	srv := testServer(store, &fakeTus{})
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "a.zip", []byte("data"))
	_, ierr := srv.streamUploadToStaging(req.Context(), "project-uploads", req, 400*1024*1024)
	if ierr == nil {
		t.Fatal("expected an error when storage fails")
	}
	if ierr.status != 502 {
		t.Errorf("status=%d want 502", ierr.status)
	}
}

func TestEscapeObjectPath(t *testing.T) {
	got := escapeObjectPath("staging/stg_ab c+d.zip")
	// Slashes separate segments and survive; spaces and plus signs do not.
	if got != "staging/stg_ab%20c+d.zip" && got != "staging/stg_ab%20c%2Bd.zip" {
		t.Errorf("unexpected escaping: %q", got)
	}
	if strings.Contains(got, " ") {
		t.Errorf("unescaped space in %q", got)
	}
}
