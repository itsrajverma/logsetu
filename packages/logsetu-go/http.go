package logsetu

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// MiddlewareOptions configure Middleware.
type MiddlewareOptions struct {
	// LogRequests emits one info/warn log per request (method, path, status, duration). Default false.
	LogRequests bool
	// DisableCapture5xx stops reporting responses with status >= 500 that didn't panic.
	DisableCapture5xx bool
	// Repanic re-raises recovered panics after reporting them (e.g. to let an outer recoverer handle them).
	// By default the middleware responds with 500 Internal Server Error itself.
	Repanic bool
	// IgnorePaths are request paths skipped entirely, e.g. "/healthz".
	IgnorePaths []string
	// Meta returns extra metadata for every log of a request (e.g. a tenant id). Optional.
	Meta func(*http.Request) Meta
	// RedactHeaders are header names (case-insensitive) replaced by "[REDACTED]" in error reports.
	// Default: Authorization, Cookie, Set-Cookie, X-Api-Key, Proxy-Authorization.
	RedactHeaders []string
}

type ctxKey int

const (
	clientKey ctxKey = iota
	requestKey
)

// FromContext returns the request-scoped client set by Middleware (tagged with the request id, method and
// path), or fallback when ctx doesn't carry one.
func FromContext(ctx context.Context, fallback *Client) *Client {
	if c, ok := ctx.Value(clientKey).(*Client); ok {
		return c
	}
	return fallback
}

// RequestID returns the request id assigned by Middleware, or "".
func RequestID(ctx context.Context) string {
	if rc := requestContext(ctx); rc != nil {
		id, _ := rc["requestId"].(string)
		return id
	}
	return ""
}

func requestContext(ctx context.Context) Meta {
	if ctx == nil {
		return nil
	}
	m, _ := ctx.Value(requestKey).(Meta)
	return m
}

// Middleware wraps an http.Handler (net/http, chi, gorilla/mux, …): it recovers and reports panics, reports 5xx
// responses, optionally logs every request, and stores a request-scoped client in the request context
// (see FromContext; the slog handler picks the request id up from the context too).
//
//	http.ListenAndServe(":8080", logsetu.Middleware(client, nil)(mux))
func Middleware(client *Client, opts *MiddlewareOptions) func(http.Handler) http.Handler {
	o := MiddlewareOptions{}
	if opts != nil {
		o = *opts
	}
	ignore := make(map[string]bool, len(o.IgnorePaths))
	for _, p := range o.IgnorePaths {
		ignore[p] = true
	}
	redact := map[string]bool{"authorization": true, "cookie": true, "set-cookie": true, "x-api-key": true, "proxy-authorization": true}
	if o.RedactHeaders != nil {
		redact = make(map[string]bool, len(o.RedactHeaders))
		for _, h := range o.RedactHeaders {
			redact[strings.ToLower(h)] = true
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if ignore[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			started := time.Now()
			id := r.Header.Get("X-Request-Id")
			if id == "" {
				id = newRequestID()
			}
			rc := Meta{"requestId": id, "method": r.Method, "path": r.URL.Path}
			if ip := clientIP(r); ip != "" {
				rc["ip"] = ip
			}
			var extra Meta
			if o.Meta != nil {
				extra = o.Meta(r)
			}
			scoped := client.With(Meta{"requestId": id, "method": r.Method, "path": r.URL.Path}).With(extra)
			ctx := context.WithValue(context.WithValue(r.Context(), clientKey, scoped), requestKey, rc)
			r = r.WithContext(ctx)
			rec := &statusRecorder{ResponseWriter: w}

			report := func(level Level, msg string, meta Meta, withHeaders bool) {
				req := Meta{"method": r.Method, "path": r.URL.Path, "query": truncate(r.URL.RawQuery, 2000)}
				if r.Pattern != "" {
					req["route"] = r.Pattern
				}
				if withHeaders {
					headers := Meta{}
					for name, values := range r.Header {
						key := strings.ToLower(name)
						if redact[key] {
							headers[key] = "[REDACTED]"
						} else {
							headers[key] = truncate(strings.Join(values, ", "), 500)
						}
					}
					req["headers"] = headers
				}
				meta["request"] = req
				meta["durationMs"] = time.Since(started).Milliseconds()
				if ip, ok := rc["ip"]; ok {
					meta["ip"] = ip
				}
				if ua := r.UserAgent(); ua != "" {
					meta["userAgent"] = ua
				}
				scoped.Log(level, msg, meta)
			}

			defer func() {
				rv := recover()
				if rv == nil {
					return
				}
				if rv == http.ErrAbortHandler { //nolint:errorlint // sentinel compared by identity, as net/http does
					panic(rv)
				}
				m := Meta{"panic": true, "stack": string(debug.Stack()), "status": http.StatusInternalServerError}
				if err, ok := rv.(error); ok {
					m["errorType"] = fmt.Sprintf("%T", err)
				}
				report(LevelError, fmt.Sprintf("panic: %v", rv), m, true)
				_ = client.Flush(context.Background())
				if o.Repanic {
					panic(rv)
				}
				if !rec.wroteHeader {
					http.Error(rec, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
				}
			}()

			next.ServeHTTP(rec, r)

			status := rec.status
			if status == 0 {
				status = http.StatusOK
			}
			switch {
			case status >= 500 && !o.DisableCapture5xx:
				report(LevelError, fmt.Sprintf("HTTP %d on %s %s", status, r.Method, r.URL.Path), Meta{"status": status}, true)
			case o.LogRequests:
				level := LevelInfo
				if status >= 400 {
					level = LevelWarn
				}
				report(level, fmt.Sprintf("%s %s %d", r.Method, r.URL.Path, status), Meta{"status": status}, false)
			}
		})
	}
}

// statusRecorder captures the status code while keeping http.Flusher / Hijacker / ResponseController working.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.status = http.StatusOK
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("logsetu: underlying ResponseWriter does not implement http.Hijacker")
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.TrimSpace(strings.Split(fwd, ",")[0])
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
