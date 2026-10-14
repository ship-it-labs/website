package main

import (
	"os"
	"strconv"
	"strings"
)

// Config is the edge's entire configuration, all from the environment so the
// container image stays portable across Render, bare metal and local docker.
type Config struct {
	// Port is the public port this process listens on. Render injects PORT;
	// Node moves to NodePort so the two never collide inside one container.
	Port string
	// UpstreamURL is the Node control plane behind the proxy (loopback).
	UpstreamURL string
	// NodePort is handed to the child as its PORT.
	NodePort string
	// NodeBin/NodeEntry/NodeArgs locate the control-plane bundle.
	NodeBin   string
	NodeEntry string
	NodeArgs  []string
	// NodeMaxOldSpace caps the child's V8 heap in MB so one unlucky request
	// cannot grow it into the OOM killer.
	NodeMaxOldSpace string
	// IngestSecret authenticates the container-internal finalize calls.
	IngestSecret string
	// SupabaseURL/SupabaseKey let the edge stream bytes straight to object
	// storage without routing them through Node's heap.
	SupabaseURL string
	SupabaseKey string
	// StorageBucket holds both the staging/ prefix and final objects.
	StorageBucket string
	// MaxUploadBytes/MaxBundleBytes mirror the Node-side caps so an abusive
	// body is rejected at the edge instead of after a full upstream read.
	MaxUploadBytes int64
	MaxBundleBytes int64
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt64(key string, def int64) int64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func splitArgs(s string) []string {
	f := strings.Fields(s)
	if f == nil {
		return []string{}
	}
	return f
}

func loadConfig() Config {
	nodePort := envOr("NODE_PORT", "3001")
	return Config{
		Port:            envOr("PORT", "3000"),
		UpstreamURL:     envOr("UPSTREAM_URL", "http://127.0.0.1:"+nodePort),
		NodePort:        nodePort,
		NodeBin:         envOr("NODE_BIN", "node"),
		NodeEntry:       envOr("NODE_ENTRY", "dist/index.js"),
		NodeArgs:        splitArgs(os.Getenv("NODE_ARGS")),
		NodeMaxOldSpace: envOr("NODE_MAX_OLD_SPACE_MB", "384"),
		IngestSecret:    os.Getenv("INTERNAL_INGEST_SECRET"),
		SupabaseURL:     os.Getenv("SUPABASE_URL"),
		SupabaseKey:     os.Getenv("SUPABASE_SERVICE_ROLE_KEY"),
		StorageBucket:   envOr("STORAGE_BUCKET", "project-uploads"),
		MaxUploadBytes:  envInt64("MAX_UPLOAD_BYTES", 400*1024*1024),
		MaxBundleBytes:  envInt64("MAX_BUNDLE_BYTES", 300*1024*1024),
	}
}

// ingestReady reports whether the edge can actually finalize an upload. A
// missing piece must read as a loud 503 at request time (and a boot warning),
// never as a half-written object with no database row behind it.
func (c Config) ingestReady() bool {
	return c.IngestSecret != "" && c.SupabaseURL != "" && c.SupabaseKey != "" && c.StorageBucket != ""
}
