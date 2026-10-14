package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeStore records what the streaming path handed it without touching the
// network. The test bodies are small, but the production path passes the
// multipart part reader straight through — nothing in ingest.go ever calls
// ReadAll or concat on the file bytes.
type fakeStore struct {
	uploaded   map[string][]byte
	deleted    [][]string
	failUpload bool
}

func (f *fakeStore) Upload(_ context.Context, _ string, path string, body io.Reader, _ string) error {
	if f.failUpload {
		return errors.New("boom")
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if f.uploaded == nil {
		f.uploaded = map[string][]byte{}
	}
	f.uploaded[path] = data
	return nil
}

func (f *fakeStore) Delete(_ context.Context, _ string, paths []string) error {
	f.deleted = append(f.deleted, paths)
	for _, p := range paths {
		delete(f.uploaded, p)
	}
	return nil
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
		req := newMultipartRequest(t, fields, fileFirst, "file", "archive.zip", body)
		res, ierr := streamUploadToStaging(req.Context(), store, "project-uploads", req, 400*1024*1024)
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
	}
}

func TestStreamUploadTooLarge(t *testing.T) {
	body := []byte(strings.Repeat("y", 100))
	store := &fakeStore{}
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "a.zip", body)
	_, ierr := streamUploadToStaging(req.Context(), store, "project-uploads", req, 10)
	if ierr == nil {
		t.Fatal("expected an error for an oversize body")
	}
	if ierr.status != 413 {
		t.Errorf("status=%d want 413", ierr.status)
	}
	if len(store.uploaded) != 0 {
		t.Errorf("oversize staging object was not cleaned up: %v", store.uploaded)
	}
	if len(store.deleted) != 1 {
		t.Errorf("expected one cleanup delete, got %d", len(store.deleted))
	}
}

func TestStreamUploadMissingFile(t *testing.T) {
	store := &fakeStore{}
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "", "", nil)
	_, ierr := streamUploadToStaging(req.Context(), store, "project-uploads", req, 400*1024*1024)
	if ierr == nil {
		t.Fatal("expected an error when no file part is present")
	}
	if ierr.status != 400 {
		t.Errorf("status=%d want 400", ierr.status)
	}
}

func TestStreamUploadStorageFailure(t *testing.T) {
	store := &fakeStore{failUpload: true}
	req := newMultipartRequest(t, map[string]string{"project_id": "p"}, false, "file", "a.zip", []byte("data"))
	_, ierr := streamUploadToStaging(req.Context(), store, "project-uploads", req, 400*1024*1024)
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
