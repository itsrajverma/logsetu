// Package logsetu ships logs and errors from Go programs to a self-hosted LogSetu server.
//
// It has no dependencies outside the standard library. Logs are queued in memory and sent in batches
// from a background goroutine; transport failures are retried with backoff and never surface to the caller.
//
//	client := logsetu.New(logsetu.Options{
//		APIKey:   os.Getenv("LOGSETU_API_KEY"),
//		Endpoint: os.Getenv("LOGSETU_ENDPOINT"),
//		Source:   "go-worker",
//	})
//	defer client.Close(context.Background())
//
//	client.Error("payment failed", logsetu.Meta{"orderId": 456})
//	slog.SetDefault(slog.New(client.SlogHandler(nil)))
package logsetu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// Version of this SDK, sent in the User-Agent header.
const Version = "0.1.0"

const maxBatch = 500

// Level is a LogSetu log level.
type Level string

const (
	LevelDebug Level = "debug"
	LevelInfo  Level = "info"
	LevelWarn  Level = "warn"
	LevelError Level = "error"
	LevelFatal Level = "fatal"
)

func (l Level) rank() int {
	switch l {
	case LevelDebug:
		return 0
	case LevelInfo:
		return 1
	case LevelWarn:
		return 2
	case LevelError:
		return 3
	case LevelFatal:
		return 4
	}
	return 1
}

// Meta is arbitrary structured metadata attached to a log.
type Meta map[string]any

// Entry is one log as sent to the ingest API.
type Entry struct {
	Level       Level     `json:"level"`
	Message     string    `json:"message"`
	Source      string    `json:"source"`
	Environment string    `json:"environment"`
	Timestamp   time.Time `json:"timestamp"`
	Meta        Meta      `json:"meta,omitempty"`
}

// Options configure a Client. APIKey and Endpoint are required; everything else has a sensible default.
type Options struct {
	// APIKey is the project API key from the LogSetu dashboard.
	APIKey string
	// Endpoint is the base URL of your LogSetu server, e.g. "https://logs.example.com".
	Endpoint string
	// Environment tags every log. Default: $LOGSETU_ENVIRONMENT or "production".
	Environment string
	// Source tags every log, e.g. "go-worker". Default: $LOGSETU_SOURCE or "go".
	Source string
	// Level is the minimum level to send. Default LevelDebug.
	Level Level
	// DefaultMeta is merged into every log.
	DefaultMeta Meta
	// FlushInterval between automatic flushes. Default 2s.
	FlushInterval time.Duration
	// BatchSize triggers a flush as soon as this many logs are queued. Default 10.
	BatchSize int
	// MaxQueueSize drops the oldest logs beyond this many. Default 1000.
	MaxQueueSize int
	// MaxRetries per batch on 429 / 5xx / network errors, with exponential backoff. Default 3; -1 disables retries.
	MaxRetries int
	// Timeout per HTTP request. Default 5s.
	Timeout time.Duration
	// Disabled turns the client into a no-op (tests, local development).
	Disabled bool
	// Debug prints every transport failure to stderr (otherwise only the first).
	Debug bool
	// BeforeSend may modify a log or drop it by returning nil.
	BeforeSend func(*Entry) *Entry
	// HTTPClient overrides the HTTP client used for ingestion.
	HTTPClient *http.Client
}

// Client queues logs and ships them in batches. It is safe for concurrent use.
// Clients derived with With share the parent's queue.
type Client struct {
	core *core
	meta Meta
}

type core struct {
	opts      Options
	ingestURL string
	enabled   bool

	mu      sync.Mutex
	queue   []Entry
	dropped int
	closed  bool

	wake    chan struct{}
	flushes chan chan struct{}
	stop    chan struct{}
	done    chan struct{}

	warnOnce sync.Once
}

// New creates a client and starts its background sender. Call Close before the program exits.
func New(opts Options) *Client {
	if opts.Environment == "" {
		opts.Environment = envOr("LOGSETU_ENVIRONMENT", "production")
	}
	if opts.Source == "" {
		opts.Source = envOr("LOGSETU_SOURCE", "go")
	}
	if opts.Level == "" {
		opts.Level = LevelDebug
	}
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = 2 * time.Second
	}
	if opts.BatchSize <= 0 {
		opts.BatchSize = 10
	}
	if opts.BatchSize > maxBatch {
		opts.BatchSize = maxBatch
	}
	if opts.MaxQueueSize <= 0 {
		opts.MaxQueueSize = 1000
	}
	if opts.MaxRetries < 0 {
		opts.MaxRetries = 0
	} else if opts.MaxRetries == 0 {
		opts.MaxRetries = 3
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 5 * time.Second
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: opts.Timeout}
	}
	c := &core{
		opts:      opts,
		ingestURL: strings.TrimRight(opts.Endpoint, "/") + "/api/v1/ingest",
		enabled:   !opts.Disabled && opts.APIKey != "" && opts.Endpoint != "",
		wake:      make(chan struct{}, 1),
		flushes:   make(chan chan struct{}),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	if !c.enabled {
		if !opts.Disabled {
			c.warn("APIKey/Endpoint not configured; logs will not be sent")
		}
		close(c.done)
	} else {
		go c.run()
	}
	return &Client{core: c, meta: copyMeta(opts.DefaultMeta)}
}

// With returns a client sharing this client's queue that adds meta to every log.
func (c *Client) With(meta Meta) *Client {
	merged := copyMeta(c.meta)
	for k, v := range meta {
		merged[k] = v
	}
	return &Client{core: c.core, meta: merged}
}

func (c *Client) Debug(msg string, meta ...Meta) { c.Log(LevelDebug, msg, meta...) }
func (c *Client) Info(msg string, meta ...Meta)  { c.Log(LevelInfo, msg, meta...) }
func (c *Client) Warn(msg string, meta ...Meta)  { c.Log(LevelWarn, msg, meta...) }
func (c *Client) Error(msg string, meta ...Meta) { c.Log(LevelError, msg, meta...) }
func (c *Client) Fatal(msg string, meta ...Meta) { c.Log(LevelFatal, msg, meta...) }

// Log queues a log. It never blocks on the network.
func (c *Client) Log(level Level, msg string, meta ...Meta) {
	k := c.core
	if !k.enabled || level.rank() < k.opts.Level.rank() {
		return
	}
	merged := copyMeta(c.meta)
	for _, m := range meta {
		for key, v := range m {
			merged[key] = v
		}
	}
	// Convenience: Meta{"error": err} → error string plus errorType, like the JS SDK.
	if err, ok := merged["error"].(error); ok {
		merged["error"] = err.Error()
		if _, has := merged["errorType"]; !has {
			merged["errorType"] = fmt.Sprintf("%T", err)
		}
	}
	if len(msg) > 10_000 {
		msg = msg[:10_000]
	}
	e := &Entry{
		Level:       level,
		Message:     msg,
		Source:      k.opts.Source,
		Environment: k.opts.Environment,
		Timestamp:   time.Now().UTC(),
		Meta:        safeMeta(merged),
	}
	if src, ok := merged["source"].(string); ok && src != "" {
		e.Source = src
		delete(e.Meta, "source")
	}
	if k.opts.BeforeSend != nil {
		if e = k.opts.BeforeSend(e); e == nil {
			return
		}
	}
	if len(e.Meta) == 0 {
		e.Meta = nil
	}
	k.enqueue(*e)
}

// CaptureError reports err as an error-level log with its type and the current goroutine's stack trace.
func (c *Client) CaptureError(err error, meta ...Meta) {
	if err == nil {
		return
	}
	c.Log(LevelError, err.Error(), append([]Meta{errorMeta(err, debug.Stack())}, meta...)...)
}

// CapturePanic reports a recovered panic value as a fatal log. Use it in a deferred recover:
//
//	defer func() {
//		if r := recover(); r != nil {
//			client.CapturePanic(r)
//			client.Flush(context.Background())
//			panic(r)
//		}
//	}()
func (c *Client) CapturePanic(recovered any, meta ...Meta) {
	m := Meta{"panic": true, "stack": string(debug.Stack())}
	if err, ok := recovered.(error); ok {
		m["errorType"] = fmt.Sprintf("%T", err)
	}
	c.Log(LevelFatal, fmt.Sprintf("panic: %v", recovered), append([]Meta{m}, meta...)...)
}

// Flush sends everything queued so far and waits for it (or for ctx to be done).
func (c *Client) Flush(ctx context.Context) error {
	k := c.core
	if !k.enabled {
		return nil
	}
	ack := make(chan struct{})
	select {
	case k.flushes <- ack:
	case <-k.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-ack:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close flushes and stops the background sender. Logs after Close are dropped.
func (c *Client) Close(ctx context.Context) error {
	k := c.core
	k.mu.Lock()
	already := k.closed
	k.closed = true
	k.mu.Unlock()
	if already || !k.enabled {
		return nil
	}
	close(k.stop)
	select {
	case <-k.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Pending is the number of queued, unsent logs.
func (c *Client) Pending() int {
	c.core.mu.Lock()
	defer c.core.mu.Unlock()
	return len(c.core.queue)
}

// Dropped is the number of logs discarded because the queue was full.
func (c *Client) Dropped() int {
	c.core.mu.Lock()
	defer c.core.mu.Unlock()
	return c.core.dropped
}

// ---------- internals ----------

func (k *core) enqueue(e Entry) {
	k.mu.Lock()
	if k.closed {
		k.mu.Unlock()
		return
	}
	k.queue = append(k.queue, e)
	if over := len(k.queue) - k.opts.MaxQueueSize; over > 0 {
		k.queue = k.queue[over:]
		k.dropped += over
	}
	full := len(k.queue) >= k.opts.BatchSize
	k.mu.Unlock()
	if full {
		select {
		case k.wake <- struct{}{}:
		default:
		}
	}
}

func (k *core) take() []Entry {
	k.mu.Lock()
	defer k.mu.Unlock()
	n := len(k.queue)
	if n > maxBatch {
		n = maxBatch
	}
	batch := k.queue[:n:n]
	k.queue = k.queue[n:]
	return batch
}

func (k *core) sendAll() {
	for {
		batch := k.take()
		if len(batch) == 0 {
			return
		}
		k.send(batch)
	}
}

func (k *core) run() {
	defer close(k.done)
	ticker := time.NewTicker(k.opts.FlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			k.sendAll()
		case <-k.wake:
			k.sendAll()
		case ack := <-k.flushes:
			k.sendAll()
			close(ack)
		case <-k.stop:
			k.sendAll()
			return
		}
	}
}

func (k *core) send(batch []Entry) {
	body, err := json.Marshal(batch)
	if err != nil {
		k.warn("could not encode batch: " + err.Error())
		return
	}
	last := "unknown error"
	for attempt := 0; attempt <= k.opts.MaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(500<<uint(attempt-1)) * time.Millisecond
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			time.Sleep(backoff + time.Duration(rand.Intn(250))*time.Millisecond)
		}
		req, err := http.NewRequest(http.MethodPost, k.ingestURL, bytes.NewReader(body))
		if err != nil {
			k.warn("invalid endpoint: " + err.Error())
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+k.opts.APIKey)
		req.Header.Set("User-Agent", "logsetu-go/"+Version)
		res, err := k.opts.HTTPClient.Do(req)
		if err != nil {
			last = err.Error()
			continue
		}
		_, _ = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return
		}
		if res.StatusCode != http.StatusTooManyRequests && res.StatusCode < 500 {
			k.warn(fmt.Sprintf("server rejected batch (HTTP %d); dropped %d logs", res.StatusCode, len(batch)))
			return
		}
		last = fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	k.warn(fmt.Sprintf("giving up after %d attempts (%s); dropped %d logs", k.opts.MaxRetries+1, last, len(batch)))
}

func (k *core) warn(msg string) {
	if k.opts.Debug {
		fmt.Fprintf(os.Stderr, "[logsetu] %s\n", msg)
		return
	}
	k.warnOnce.Do(func() {
		fmt.Fprintf(os.Stderr, "[logsetu] %s (further transport warnings suppressed; set Debug: true to see them)\n", msg)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func copyMeta(m Meta) Meta {
	out := make(Meta, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func errorMeta(err error, stack []byte) Meta {
	m := Meta{"errorType": fmt.Sprintf("%T", err), "stack": string(stack)}
	var chain []string
	for e := errors.Unwrap(err); e != nil && len(chain) < 10; e = errors.Unwrap(e) {
		chain = append(chain, e.Error())
	}
	if len(chain) > 0 {
		m["causes"] = chain
	}
	return m
}

// safeMeta makes values JSON-encodable: errors become strings, anything json.Marshal rejects becomes %v.
func safeMeta(m Meta) Meta {
	for k, v := range m {
		switch t := v.(type) {
		case nil, string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64,
			time.Time, time.Duration, []string:
		case error:
			m[k] = t.Error()
		case fmt.Stringer:
			m[k] = t.String()
		default:
			if _, err := json.Marshal(v); err != nil {
				m[k] = fmt.Sprintf("%+v", v)
			}
		}
	}
	return m
}
