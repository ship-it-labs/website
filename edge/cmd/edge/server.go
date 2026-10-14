package main

import (
	"log/slog"
	"net/http"
)

// Server fronts the Node control plane. Two multipart routes are intercepted
// and streamed; every other request — API, websockets, /health, static
// assets, the SPA fallback — passes straight through to Node.
type Server struct {
	cfg   Config
	store objectStore
	proxy http.Handler
	log   *slog.Logger
}

func NewServer(cfg Config, log *slog.Logger) *Server {
	return &Server{
		cfg:   cfg,
		store: NewStorage(cfg.SupabaseURL, cfg.SupabaseKey),
		proxy: newProxy(cfg.UpstreamURL),
		log:   log,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/projects/upload", s.handleProjectUpload)
	mux.HandleFunc("POST /api/v1/builds/{id}/bundle", s.handleBundleUpload)
	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/", s.proxy)
	return mux
}

func (s *Server) notReady() *ingestError {
	if s.cfg.ingestReady() {
		return nil
	}
	s.log.Error("ingest route hit but the edge is missing configuration")
	return &ingestError{
		status:  503,
		code:    "UPLOAD_UNAVAILABLE",
		message: "Uploads are not configured on this deployment",
	}
}

// handleProjectUpload streams the project archive to staging, then asks Node
// to finalize (identity, language, env crypto, database, signed URL) and
// relays Node's response verbatim.
func (s *Server) handleProjectUpload(w http.ResponseWriter, r *http.Request) {
	if err := s.notReady(); err != nil {
		writeIngestError(w, err)
		return
	}
	res, ierr := streamUploadToStaging(r.Context(), s.store, s.cfg.StorageBucket, r, s.cfg.MaxUploadBytes)
	if ierr != nil {
		writeIngestError(w, ierr)
		return
	}
	status, body, err := callFinalize(r.Context(), s.cfg.UpstreamURL, s.cfg.IngestSecret, "/internal/ingest/project", map[string]any{
		"authorization": r.Header.Get("Authorization"),
		"staging_path":  res.stagingPath,
		"sha256":        res.sha256,
		"bytes":         res.bytes,
		"filename":      res.filename,
		"project_id":    res.fields["project_id"],
		"project_name":  res.fields["project_name"],
		"run_command":   res.fields["run_command"],
		"language":      res.fields["language"],
		"env":           res.fields["env"],
		"manifest":      res.fields["manifest"],
	})
	if err != nil {
		s.log.Error("project finalize failed", "error", err, "staging", res.stagingPath)
		writeIngestError(w, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to record the project upload"})
		return
	}
	s.log.Info("project uploaded via edge",
		"project_id", res.fields["project_id"], "bytes", res.bytes, "sha256", res.sha256)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// handleBundleUpload does the same for CI-built runtime bundles, which
// authenticate with the shared build-report token rather than a user key.
func (s *Server) handleBundleUpload(w http.ResponseWriter, r *http.Request) {
	if err := s.notReady(); err != nil {
		writeIngestError(w, err)
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeIngestError(w, &ingestError{status: 400, code: "VALIDATION_ERROR", message: "build id is required"})
		return
	}
	res, ierr := streamUploadToStaging(r.Context(), s.store, s.cfg.StorageBucket, r, s.cfg.MaxBundleBytes)
	if ierr != nil {
		if ierr.status == 413 {
			ierr = &ingestError{status: 413, code: "BUNDLE_TOO_LARGE", message: ierr.message}
		}
		writeIngestError(w, ierr)
		return
	}
	status, body, err := callFinalize(r.Context(), s.cfg.UpstreamURL, s.cfg.IngestSecret, "/internal/ingest/bundle", map[string]any{
		"build_token":  r.Header.Get("X-Build-Report-Token"),
		"build_id":     id,
		"staging_path": res.stagingPath,
		"sha256":       res.sha256,
		"bytes":        res.bytes,
	})
	if err != nil {
		s.log.Error("bundle finalize failed", "error", err, "build_id", id, "staging", res.stagingPath)
		writeIngestError(w, &ingestError{status: 502, code: "STORAGE_UNAVAILABLE", message: "Failed to record the bundle"})
		return
	}
	s.log.Info("bundle uploaded via edge", "build_id", id, "bytes", res.bytes, "sha256", res.sha256)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
