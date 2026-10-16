package main

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// newProxy forwards everything that is not a large-body ingest route to the
// Node control plane unchanged: same paths, same headers, same bodies,
// including websocket upgrades (ReverseProxy has passed Upgrade through since
// Go 1.12). Nothing the plugin, dashboard or CI calls today changes shape.
func newProxy(upstream string, log *slog.Logger) *httputil.ReverseProxy {
	target, err := url.Parse(upstream)
	if err != nil {
		// A bad UPSTREAM_URL is a boot-time misconfiguration; crash loudly
		// rather than serving 502s with no explanation.
		panic("invalid UPSTREAM_URL: " + err.Error())
	}
	p := httputil.NewSingleHostReverseProxy(target)
	orig := p.Director
	p.Director = func(r *http.Request) {
		orig(r)
		// Render terminates TLS at its edge, so by the time a request reaches
		// this loopback proxy the scheme is http. Anything downstream that
		// builds absolute URLs (redirects, signed links) must see https.
		if r.Header.Get("X-Forwarded-Proto") == "" {
			r.Header.Set("X-Forwarded-Proto", "https")
		}
	}
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		// Node is still booting, or died. 502 with a retryable message, not a
		// stack trace: CI already retries these. Logged server-side because a
		// proxy failure otherwise leaves no trace anywhere (Node never saw
		// the request, so its logs stay silent and callers only see 502).
		log.Error("proxy upstream unavailable",
			"method", r.Method, "path", r.URL.Path, "error", err)
		writeIngestError(w, &ingestError{
			status:  502,
			code:    "UPSTREAM_UNAVAILABLE",
			message: "The application is starting up; retry shortly",
		})
	}
	return p
}
