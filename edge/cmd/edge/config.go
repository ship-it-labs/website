package main

import (
	"os"
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
	// OrchestratorURL/OrchestratorSecret point at the server-orchestrator,
	// which picks the storing agent (random healthy, or the project's home)
	// and pipes bytes through to it. The edge holds no agent addresses and no
	// agent secret — same service secret the control plane already uses. The
	// 20GB size cap lives on the storing agent, which answers 413 past it.
	OrchestratorURL    string
	OrchestratorSecret string
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
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
		IngestSecret:       os.Getenv("INTERNAL_INGEST_SECRET"),
		OrchestratorURL:    os.Getenv("ORCHESTRATOR_URL"),
		OrchestratorSecret: os.Getenv("ORCHESTRATOR_SECRET"),
	}
}

// ingestReady reports whether the edge can actually store an upload. A
// missing piece must read as a loud 503 at request time (and a boot warning),
// never as bytes accepted with nowhere to put them.
func (c Config) ingestReady() bool {
	return c.IngestSecret != "" && c.OrchestratorURL != "" && c.OrchestratorSecret != ""
}
