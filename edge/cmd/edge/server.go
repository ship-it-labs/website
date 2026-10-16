package main

import (
	"log/slog"
	"net/http"
)

// Server fronts the Node control plane. The project-upload route is
// intercepted and streamed to Supabase staging (Node never buffers it);
// bundle uploads proxy straight to Node, which streams them to the live
// runtime's host or discards them when nothing runs. Every other request —
// API, websockets, /health, static assets, the SPA fallback — passes straight
// through to Node.
type Server struct {
	cfg   Config
	store objectStore
	tus   tusUploader
	proxy http.Handler
	log   *slog.Logger
}

func NewServer(cfg Config, log *slog.Logger) *Server {
	return &Server{
		cfg:   cfg,
		store: NewStorage(cfg.SupabaseURL, cfg.SupabaseKey, log),
		tus:   newTusClient(cfg.SupabaseURL, cfg.SupabaseKey, log),
		proxy: newProxy(cfg.UpstreamURL, log),
		log:   log,
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/projects/upload", s.handleProjectUpload)
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
	res, ierr := s.streamUploadToStaging(r.Context(), s.cfg.StorageBucket, r, s.cfg.MaxUploadBytes)
	if ierr != nil {
		// Logged: storage rejections are otherwise silent (the caller gets a
		// generic 502), which once left a bundle failure with no trace.
		s.log.Error("project ingest failed",
			"status", ierr.status, "code", ierr.code, "message", ierr.message)
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
