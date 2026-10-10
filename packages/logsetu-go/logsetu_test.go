package logsetu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeServer struct {
	*httptest.Server
	mu       sync.Mutex
	entries  []Entry
	auth     []string
	requests atomic.Int32
	failN    int32 // respond 503 to the first failN requests
	status   int
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	f := &fakeServer{status: http.StatusAccepted}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := f.requests.Add(1)
		if r.URL.Path != "/api/v1/ingest" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if n <= f.failN {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var batch []Entry
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Errorf("decode: %v", err)
		}
		f.mu.Lock()
		f.entries = append(f.entries, batch...)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		w.WriteHeader(f.status)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeServer) logs() []Entry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Entry(nil), f.entries...)
}

func newTestClient(f *fakeServer, opts Options) *Client {
	opts.APIKey = "ls_test"
	opts.Endpoint = f.URL + "/"
	if opts.Source == "" {
		opts.Source = "test"
	}
	if opts.Environment == "" {
		opts.Environment = "ci"
	}
	return New(opts)
}

func flush(t *testing.T, c *Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.Flush(ctx); err != nil {
		t.Fatalf("flush: %v", err)
	}
}

func TestBatchesAndFlushes(t *testing.T) {
	f := newFakeServer(t)
	c := newTestClient(f, Options{FlushInterval: time.Hour, DefaultMeta: Meta{"service": "billing"}})
	defer c.Close(context.Background())

	c.Info("one", Meta{"a": 1})
	c.Warn("two")
	if got := f.requests.Load(); got != 0 {
		t.Fatalf("sent before flush: %d requests", got)
	}
	flush(t, c)

	logs := f.logs()
	if len(logs) != 2 || logs[0].Message != "one" || logs[1].Level != LevelWarn {
		t.Fatalf("unexpected logs: %+v", logs)
	}
	if logs[0].Source != "test" || logs[0].Environment != "ci" || logs[0].Meta["a"] != float64(1) || logs[0].Meta["service"] != "billing" {
		t.Fatalf("unexpected entry: %+v", logs[0])
	}
	if f.auth[0] != "Bearer ls_test" {
		t.Fatalf("auth header %q", f.auth[0])
	}
	if f.requests.Load() != 1 {
		t.Fatalf("expected one batched request, got %d", f.requests.Load())
	}
}

func TestFlushesOnIntervalAndBatchSize(t *testing.T) {
	f := newFakeServer(t)
	c := newTestClient(f, Options{FlushInterval: 50 * time.Millisecond})
	c.Info("tick")
	waitFor(t, func() bool { return len(f.logs()) == 1 })
	c.Close(context.Background())

	f2 := newFakeServer(t)
	c2 := newTestClient(f2, Options{FlushInterval: time.Hour, BatchSize: 3})
	defer c2.Close(context.Background())
	for i := 0; i < 3; i++ {
		c2.Info(fmt.Sprintf("m%d", i))
	}
	waitFor(t, func() bool { return len(f2.logs()) == 3 })
}

func TestRetriesOn5xxAndDropsOn4xx(t *testing.T) {
	f := newFakeServer(t)
	f.failN = 2
	c := newTestClient(f, Options{FlushInterval: time.Hour})
	c.Error("retry me")
	flush(t, c)
	if f.requests.Load() != 3 || len(f.logs()) != 1 {
		t.Fatalf("requests=%d logs=%d", f.requests.Load(), len(f.logs()))
	}
	c.Close(context.Background())

	f2 := newFakeServer(t)
	f2.status = http.StatusUnauthorized
	c2 := newTestClient(f2, Options{FlushInterval: time.Hour})
	defer c2.Close(context.Background())
	c2.Error("nope")
	flush(t, c2)
	if f2.requests.Load() != 1 {
		t.Fatalf("4xx should not be retried, got %d requests", f2.requests.Load())
	}
}

func TestLevelFilterBeforeSendWithAndErrors(t *testing.T) {
	f := newFakeServer(t)
	c := newTestClient(f, Options{
		FlushInterval: time.Hour,
		Level:         LevelInfo,
		BeforeSend: func(e *Entry) *Entry {
			if strings.Contains(e.Message, "secret") {
				return nil
			}
			return e
		},
	})
	defer c.Close(context.Background())

	c.Debug("too quiet")
	c.Info("has secret")
	child := c.With(Meta{"tenant": "acme"})
	child.Warn("from child", Meta{"source": "cron"})
	wrapped := fmt.Errorf("charge card: %w", errors.New("card declined"))
	c.CaptureError(wrapped, Meta{"orderId": 9})
	c.Error("with error meta", Meta{"error": errors.New("boom")})
	flush(t, c)

	logs := f.logs()
	if len(logs) != 3 {
		t.Fatalf("expected 3 logs, got %+v", logs)
	}
	if logs[0].Meta["tenant"] != "acme" || logs[0].Source != "cron" {
		t.Fatalf("child log: %+v", logs[0])
	}
	if logs[1].Message != "charge card: card declined" || logs[1].Level != LevelError ||
		!strings.Contains(logs[1].Meta["stack"].(string), "goroutine") || logs[1].Meta["orderId"] != float64(9) {
		t.Fatalf("captured error: %+v", logs[1])
	}
	if causes := logs[1].Meta["causes"].([]any); causes[0] != "card declined" {
		t.Fatalf("causes: %+v", causes)
	}
	if logs[2].Meta["error"] != "boom" || logs[2].Meta["errorType"] != "*errors.errorString" {
		t.Fatalf("error meta: %+v", logs[2].Meta)
	}
}

func TestDisabledAndMisconfiguredClientsAreNoops(t *testing.T) {
	c := New(Options{Disabled: true})
	c.Error("ignored")
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestCloseFlushesAndLaterCallsAreSafe(t *testing.T) {
	f := newFakeServer(t)
	c := newTestClient(f, Options{FlushInterval: time.Hour})
	c.Info("last words")
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.Info("after close")
	if err := c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if logs := f.logs(); len(logs) != 1 || logs[0].Message != "last words" {
		t.Fatalf("logs: %+v", logs)
	}
}

func TestSlogHandler(t *testing.T) {
	f := newFakeServer(t)
	c := newTestClient(f, Options{FlushInterval: time.Hour})
	defer c.Close(context.Background())
	logger := slog.New(c.SlogHandler(nil)).With("service", "api").WithGroup("http").With("route", "/pay")

	logger.Debug("dropped by level")
	logger.Error("payment failed", "status", 502, slog.Group("upstream", "name", "stripe"))
	slog.New(c.SlogHandler(&SlogOptions{Level: slog.LevelDebug})).Debug("verbose", "n", 1)
	flush(t, c)

	logs := f.logs()
	if len(logs) != 2 {
		t.Fatalf("expected 2 logs, got %+v", logs)
	}
	m := logs[0].Meta
	httpGroup, _ := m["http"].(map[string]any)
	upstream, _ := httpGroup["upstream"].(map[string]any)
	if logs[0].Level != LevelError || m["service"] != "api" || httpGroup["route"] != "/pay" ||
		httpGroup["status"] != float64(502) || upstream["name"] != "stripe" {
		t.Fatalf("slog entry: %+v", logs[0])
	}
	if logs[1].Level != LevelDebug || logs[1].Meta["n"] != float64(1) {
		t.Fatalf("debug entry: %+v", logs[1])
	}
}

func TestMiddleware(t *testing.T) {
	f := newFakeServer(t)
	c := newTestClient(f, Options{FlushInterval: time.Hour})
	defer c.Close(context.Background())
	logger := slog.New(c.SlogHandler(nil))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ok", func(w http.ResponseWriter, r *http.Request) {
		FromContext(r.Context(), c).Info("inside handler")
		logger.WarnContext(r.Context(), "slog inside handler")
		fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("GET /boom/{id}", func(w http.ResponseWriter, r *http.Request) {
		panic(errors.New("kaboom"))
	})
	mux.HandleFunc("GET /down", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	})
	mux.HandleFunc("GET /missing", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {})

	handler := Middleware(c, &MiddlewareOptions{
		LogRequests: true,
		IgnorePaths: []string{"/healthz"},
		Meta:        func(r *http.Request) Meta { return Meta{"tenant": r.Header.Get("X-Tenant")} },
	})(mux)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	get := func(path string, headers map[string]string) int {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if s := get("/ok", map[string]string{"X-Request-Id": "req-1", "X-Tenant": "acme"}); s != 200 {
		t.Fatalf("/ok status %d", s)
	}
	if s := get("/boom/7", map[string]string{"Authorization": "Bearer secret"}); s != 500 {
		t.Fatalf("/boom status %d", s)
	}
	get("/down", nil)
	get("/missing", nil)
	get("/healthz", nil)
	flush(t, c)

	logs := f.logs()
	var msgs []string
	for _, l := range logs {
		msgs = append(msgs, string(l.Level)+" "+l.Message)
	}
	want := []string{
		"info inside handler",
		"warn slog inside handler",
		"info GET /ok 200",
		"error panic: kaboom",
		"error HTTP 503 on GET /down",
		"warn GET /missing 404",
	}
	if strings.Join(msgs, "|") != strings.Join(want, "|") {
		t.Fatalf("got  %q\nwant %q", msgs, want)
	}
	if logs[0].Meta["requestId"] != "req-1" || logs[0].Meta["tenant"] != "acme" || logs[0].Meta["path"] != "/ok" {
		t.Fatalf("scoped client meta: %+v", logs[0].Meta)
	}
	if req, _ := logs[1].Meta["request"].(map[string]any); req["requestId"] != "req-1" {
		t.Fatalf("slog request context: %+v", logs[1].Meta)
	}
	panicLog := logs[3]
	req := panicLog.Meta["request"].(map[string]any)
	headers := req["headers"].(map[string]any)
	if req["route"] != "GET /boom/{id}" || headers["authorization"] != "[REDACTED]" ||
		!strings.Contains(panicLog.Meta["stack"].(string), "logsetu_test.go") || panicLog.Meta["status"] != float64(500) {
		t.Fatalf("panic log: %+v", panicLog.Meta)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met within 5s")
}
