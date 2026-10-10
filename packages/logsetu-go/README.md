# logsetu-go

Ship logs, errors and panics from Go services to your self-hosted [LogSetu](https://github.com/itsrajverma/logsetu)
server. Standard library only, non-blocking (background goroutine + batching + retry), and it never crashes or slows down
your program when the log server is unreachable.

```bash
go get github.com/itsrajverma/logsetu/packages/logsetu-go
```

Requires Go 1.23+.

## Quick start

```go
import (
	"context"
	"os"

	logsetu "github.com/itsrajverma/logsetu/packages/logsetu-go"
)

func main() {
	client := logsetu.New(logsetu.Options{
		APIKey:      os.Getenv("LOGSETU_API_KEY"),
		Endpoint:    os.Getenv("LOGSETU_ENDPOINT"), // e.g. https://logs.example.com
		Environment: "production",
		Source:      "go-worker",
	})
	defer client.Close(context.Background()) // flushes whatever is still queued

	client.Info("worker started", logsetu.Meta{"queue": "emails"})
	if err := chargeCard(); err != nil {
		client.CaptureError(err, logsetu.Meta{"orderId": 456}) // message, error type, wrapped causes, stack
	}
}
```

## log/slog

```go
slog.SetDefault(slog.New(client.SlogHandler(&logsetu.SlogOptions{Level: slog.LevelWarn})))

slog.Error("payment failed", "orderId", 456, "error", err)
```

Attributes become metadata (groups become nested objects), and `slog.ErrorContext(r.Context(), …)` inside a request
wrapped by the middleware also attaches the request id, method and path. To log to stdout *and* LogSetu, fan out with
`slog.NewMultiHandler` (Go 1.26+) or any multi-handler package.

## net/http middleware

```go
mux := http.NewServeMux()
mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
	log := logsetu.FromContext(r.Context(), client) // tagged with requestId, method, path
	log.Info("loading order")
	// ...
})

handler := logsetu.Middleware(client, &logsetu.MiddlewareOptions{
	LogRequests: true,
	IgnorePaths: []string{"/healthz"},
	Meta: func(r *http.Request) logsetu.Meta { return logsetu.Meta{"tenant": r.Header.Get("X-Tenant")} },
})(mux)
http.ListenAndServe(":8080", handler)
```

The middleware:

- recovers panics, reports them as errors with the stack trace, route pattern and redacted headers, and responds `500`
  (set `Repanic: true` to re-raise instead);
- reports responses with status `>= 500` (disable with `DisableCapture5xx`);
- optionally logs every request with status and duration (`LogRequests`);
- honours an incoming `X-Request-Id` header or generates one (`logsetu.RequestID(ctx)`).

It's a plain `func(http.Handler) http.Handler`, so it works with chi, gorilla/mux and anything else built on `net/http`.

## Options

| Field | Default | Description |
|---|---|---|
| `APIKey` | — | Project API key |
| `Endpoint` | — | Base URL of your LogSetu server |
| `Environment` | `$LOGSETU_ENVIRONMENT` or `"production"` | Tag on every log |
| `Source` | `$LOGSETU_SOURCE` or `"go"` | Tag on every log (a `"source"` meta key overrides it per log) |
| `Level` | `LevelDebug` | Minimum level to send |
| `DefaultMeta` | — | Metadata merged into every log |
| `FlushInterval` | `2s` | Time between automatic flushes |
| `BatchSize` | `10` | Flush as soon as this many logs are queued |
| `MaxQueueSize` | `1000` | Drop the oldest logs beyond this |
| `MaxRetries` | `3` | Retries on 429 / 5xx / network errors, with exponential backoff (`-1` disables) |
| `Timeout` | `5s` | Per-request HTTP timeout |
| `Disabled` | `false` | Turn the client into a no-op (tests, local dev) |
| `Debug` | `false` | Print every transport failure to stderr (otherwise only the first) |
| `BeforeSend` | — | `func(*Entry) *Entry` to scrub or drop logs (return `nil`) |
| `HTTPClient` | — | Custom `*http.Client` |

## API

- `client.Debug / Info / Warn / Error / Fatal(msg, meta...)`, `client.Log(level, msg, meta...)`
- `client.CaptureError(err, meta...)` and `client.CapturePanic(recovered, meta...)`
- `client.With(meta)` returns a logger that shares the same queue and adds metadata
- `client.Flush(ctx)` sends everything queued now (call it before a short-lived program or Lambda handler returns)
- `client.Close(ctx)` flushes and stops the background goroutine
- `client.Pending()` / `client.Dropped()`

## License

MIT
