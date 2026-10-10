# logsetu-js

Tiny (≈2.5 KB gzipped), zero-dependency SDK that ships logs from **Next.js, React, Node.js, Express and Hono** to your
self-hosted [LogSetu](https://github.com/itsrajverma/logsetu) server. Batches, retries with backoff, never
blocks your app, and works in both the browser and on the server.

```bash
npm install logsetu-js
```

## Quick start

```ts
import { LogSetu } from "logsetu-js";

const logger = LogSetu.init({
  apiKey: process.env.NEXT_PUBLIC_LOGSETU_API_KEY!, // from the LogSetu dashboard → Projects
  endpoint: "https://logs.example.com",             // your LogSetu server
  environment: "production",
  source: "nextjs-web",
});

logger.info("User logged in", { userId: 123 });
logger.warn("Cart abandoned", { cartId: "c_9" });
logger.error("Payment failed", { error: err, orderId: 456 }); // Error objects are serialized with stack
logger.captureException(err, { where: "checkout" });          // any thrown value → error log + stack
```

`LogSetu.init` also registers a default client, so anywhere else you can simply call `LogSetu.info(...)`,
`LogSetu.captureException(...)` etc. without passing the logger around.

## Next.js (App Router)

### 1. Server side — `instrumentation.ts`

Captures unhandled errors from Server Components, Route Handlers, Server Actions and middleware, plus
unhandled rejections / uncaught exceptions in the Node process.

```ts
// instrumentation.ts (project root or src/)
import { registerLogSetu, createOnRequestError } from "logsetu-js/next";

export function register() {
  registerLogSetu({
    apiKey: process.env.LOGSETU_API_KEY!,
    endpoint: process.env.LOGSETU_ENDPOINT!,
    environment: process.env.NODE_ENV,
    source: "nextjs-server",
  });
}

export const onRequestError = createOnRequestError();
```

Then log from any server code with the default client:

```ts
import { LogSetu } from "logsetu-js";

export default async function Page() {
  LogSetu.info("Rendering dashboard", { path: "/dashboard" });
  ...
}
```

Optionally wrap Route Handlers to get per-request logs with status and duration:

```ts
import { withLogSetu } from "logsetu-js/next";

export const GET = withLogSetu(async (req) => Response.json({ ok: true }), { logRequests: true });
```

### 2. Browser side — a client module

```ts
// lib/logsetu.ts
"use client";
import { LogSetu } from "logsetu-js";

export const logger = LogSetu.init({
  apiKey: process.env.NEXT_PUBLIC_LOGSETU_API_KEY!,
  endpoint: process.env.NEXT_PUBLIC_LOGSETU_ENDPOINT!,
  environment: process.env.NODE_ENV,
  source: "nextjs-web",
});
```

> The same project API key works for both browser and server. Logs sent from the browser are flushed with
> `navigator.sendBeacon` when the tab is hidden or closed, so nothing is lost on navigation.

### 3. React error boundary

```tsx
import { LogSetuErrorBoundary } from "logsetu-js/react";

<LogSetuErrorBoundary fallback={(error, reset) => <button onClick={reset}>Try again</button>}>
  <App />
</LogSetuErrorBoundary>
```

Uncaught render errors are reported with the React component stack and the current URL. Works in plain
React (Vite / CRA) too — `logsetu-js/react` has no Next.js dependency.

## Express

```ts
import express from "express";
import { LogSetu } from "logsetu-js";
import { logsetuMiddleware, logsetuErrorHandler } from "logsetu-js/express";

LogSetu.init({ apiKey: process.env.LOGSETU_API_KEY!, endpoint: process.env.LOGSETU_ENDPOINT!, source: "express-api" });

const app = express();
app.use(logsetuMiddleware({ logRequests: true, ignorePaths: ["/healthz"] }));

app.get("/orders/:id", (req, res) => {
  req.logsetu.info("loading order", { orderId: req.params.id }); // tagged with requestId, method, path
  // ...
});

app.use(logsetuErrorHandler()); // after your routes
```

- `logsetuMiddleware(options)` gives every request a `req.logsetu` child logger (honouring an incoming `X-Request-Id`),
  reports responses with status `>= 500` and, with `logRequests: true`, logs each request with status and duration.
- `logsetuErrorHandler()` reports thrown errors (route, IP, user agent, stack) and passes them on with `next(err)`;
  errors carrying a `status` / `statusCode` below 500 (e.g. `http-errors`) are not reported.
- Options: `client`, `logRequests`, `capture5xx` (default `true`), `ignorePaths`, and `meta` — an object or
  `(req) => meta` (e.g. a tenant id). Works with Express 4 and 5; `express` is not a dependency.

## Hono

```ts
import { Hono } from "hono";
import { LogSetu, type LogSetuClient } from "logsetu-js";
import { logsetu } from "logsetu-js/hono";

const app = new Hono<{ Variables: { logsetu: LogSetuClient } }>();
app.use(logsetu({ client: LogSetu.init({ apiKey: "ls_…", endpoint: "https://logs.example.com", source: "hono-api" }) }));

app.get("/", (c) => {
  c.get("logsetu").info("hello");
  return c.text("ok");
});
```

The middleware reports thrown errors (`HTTPException`s below 500 are skipped) and 5xx responses, optionally logs every
request (`logRequests: true`), and exposes a request-scoped logger as `c.get("logsetu")`. On Cloudflare Workers and
other runtimes with an `executionCtx`, logs are flushed through `waitUntil` after each request so nothing is lost when
the isolate is frozen; pass `flush: true` to flush (awaited) on runtimes without one. Same `client` / `capture5xx` /
`ignorePaths` / `meta` options as Express. `hono` is not a dependency.

## Options

| Option | Default | Description |
|---|---|---|
| `apiKey` | — | Project API key |
| `endpoint` | — | Base URL of your LogSetu server |
| `environment` | `NODE_ENV` or `"production"` | Tag on every log |
| `source` | `"browser"` / `"node"` | Tag on every log |
| `level` | `"debug"` | Minimum level to send |
| `defaultMeta` | `{}` | Metadata merged into every log (e.g. `{ tenant_id }`) |
| `flushInterval` | `2000` | ms between flushes |
| `batchSize` | `10` | Flush as soon as this many logs are queued |
| `maxQueueSize` | `1000` | Drop oldest beyond this |
| `maxRetries` | `3` | Retries with exponential backoff on 429 / 5xx / network errors |
| `enabled` | `true` | `false` turns the SDK into a no-op (tests, local dev) |
| `console` | `false` | Also print logs to the console |
| `debug` | `false` | Print every transport failure (otherwise only the first) |
| `beforeSend` | — | `(entry) => entry \| null` to scrub or drop logs |
| `fetch` | global `fetch` | Custom fetch implementation |

## API

- `logger.debug / info / warn / error / fatal(message, meta?)`
- `logger.log(level, message, meta?)`
- `logger.captureException(error, meta?, level = "error")`
- `logger.setContext(meta)` — merge metadata into all subsequent logs (user id, tenant, release…)
- `logger.child(meta, { source? })` — a logger sharing the same queue with extra metadata
- `await logger.flush()` — send everything queued now (e.g. before a serverless function returns)
- `await logger.close()` — flush and stop timers

Everything is fully typed; `.d.ts` files ship with the package (ESM + CJS).

## Serverless / edge

Route Handlers on Vercel and similar platforms may freeze before the 2s flush timer fires — call
`await LogSetu.flush()` at the end of the handler. Errors are always flushed immediately by `withLogSetu` and
`createOnRequestError`. The core client has no Node-only APIs and runs in the Edge runtime.

## License

MIT
