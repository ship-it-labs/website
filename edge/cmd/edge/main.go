package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)
	cfg := loadConfig()

	if !cfg.ingestReady() {
		// Warn, don't die: the container still serves the whole API through
		// the proxy, only the two streaming upload routes degrade to 503.
		// Dying here would take down health checks and the dashboard over an
		// upload path nobody may be using yet.
		log.Warn("ingest storage is not configured; upload routes will return 503",
			"hint", "set INTERNAL_INGEST_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	nodeCmd, err := startNode(ctx, cfg, log)
	if err != nil {
		log.Error("could not start the control plane", "error", err)
		os.Exit(1)
	}

	// If the child dies on its own (bad boot, fatal assert), there is no
	// point serving a proxy to nothing: shut the container down so the
	// platform restarts it instead of serving 502s indefinitely.
	go func() {
		err := nodeCmd.Wait()
		select {
		case <-ctx.Done():
			return
		default:
		}
		log.Error("node child exited unexpectedly", "error", err)
		cancel()
	}()

	if err := waitForUpstream(ctx, cfg.UpstreamURL, 90*time.Second); err != nil {
		log.Error("control plane never became ready", "error", err)
		cancel()
		_ = nodeCmd.Wait()
		os.Exit(1)
	}
	log.Info("control plane is ready", "upstream", cfg.UpstreamURL)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           NewServer(cfg, log).Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// No read/write timeouts on purpose: a legitimate 400MB upload takes
		// minutes, and the handlers already cap size and honor cancellation.
		MaxHeaderBytes: 1 << 20,
	}
	go func() {
		log.Info("edge listening", "port", cfg.Port, "upstream", cfg.UpstreamURL)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http server failed", "error", err)
			cancel()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
	// CommandContext already signalled the child via cancel(); Wait reaps it
	// so no zombie lingers past container exit.
	_ = nodeCmd.Wait()
}
