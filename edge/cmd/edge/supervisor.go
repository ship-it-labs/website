package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"time"
)

// startNode launches the control plane as a child process on the loopback
// port. Its stdout/stderr inherit the container's, so Render shows one merged
// log stream with Node's own lines intact. The V8 heap cap rides along as a
// node flag: it is the backstop that keeps a single unlucky request from
// growing the child into the OOM killer even behind the streaming edge.
func startNode(ctx context.Context, cfg Config, log *slog.Logger) (*exec.Cmd, error) {
	env := os.Environ()
	setEnv := func(k, v string) {
		prefix := k + "="
		for i, e := range env {
			if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
				env[i] = prefix + v
				return
			}
		}
		env = append(env, prefix+v)
	}
	setEnv("PORT", cfg.NodePort)
	args := []string{}
	if cfg.NodeMaxOldSpace != "" {
		args = append(args, "--max-old-space-size="+cfg.NodeMaxOldSpace)
	}
	args = append(args, cfg.NodeEntry)
	args = append(args, cfg.NodeArgs...)
	cmd := exec.CommandContext(ctx, cfg.NodeBin, args...)
	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start node: %w", err)
	}
	log.Info("node child started", "pid", cmd.Process.Pid, "port", cfg.NodePort)
	return cmd, nil
}

// waitForUpstream blocks until Node's /health answers 200. Serving the public
// port before the child is up would turn every early probe into a 502 and
// hide a broken boot behind "starting up" forever; failing here instead makes
// a bad deploy crash loudly where the platform can see it.
func waitForUpstream(ctx context.Context, upstream string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 5 * time.Second}
	for {
		var lastErr error
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstream+"/health", nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			status := resp.StatusCode
			resp.Body.Close()
			if status == 200 {
				return nil
			}
			lastErr = fmt.Errorf("status %d", status)
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("upstream %s not ready after %s: %v", upstream, timeout, lastErr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
