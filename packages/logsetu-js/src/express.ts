import { LogSetu, LogSetuClient, type LogMeta } from "./index";

export { LogSetu, LogSetuClient };

// Minimal structural types so the SDK doesn't depend on `express` (works with Express 4 and 5, and Connect).
export interface ExpressLikeRequest {
  method: string;
  originalUrl?: string;
  url: string;
  path?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: unknown };
  socket?: { remoteAddress?: string };
  logsetu?: LogSetuClient;
  logsetuRequestId?: string;
}
export interface ExpressLikeResponse {
  statusCode: number;
  headersSent?: boolean;
  on(event: "finish" | "close", cb: () => void): unknown;
}
export type NextFunction = (err?: unknown) => void;

export interface ExpressOptions {
  /** Client to use. Defaults to `LogSetu.get()` (the client created by `LogSetu.init`). */
  client?: LogSetuClient;
  /** Emit an info log per completed request (method, path, status, duration). Default false. */
  logRequests?: boolean;
  /** Report responses with status >= 500 that didn't go through `logsetuErrorHandler`. Default true. */
  capture5xx?: boolean;
  /** Extra metadata for every log, or a function of the request (e.g. tenant id). */
  meta?: LogMeta | ((req: ExpressLikeRequest) => LogMeta | undefined);
  /** Request paths to skip entirely, e.g. ["/healthz"]. */
  ignorePaths?: (string | RegExp)[];
}

// Types `req.logsetu` / `req.logsetuRequestId` for Express users (merges into @types/express' Request).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Request-scoped logger set by `logsetuMiddleware` (undefined if the middleware isn't installed). */
      logsetu: LogSetuClient;
      logsetuRequestId?: string;
    }
  }
}

const REPORTED = Symbol.for("logsetu.reported");

function header(req: ExpressLikeRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function pathOf(req: ExpressLikeRequest): string {
  return req.path ?? (req.originalUrl ?? req.url).split("?")[0] ?? "/";
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

/** Request metadata shared by the middleware and the error handler. */
export function requestMeta(req: ExpressLikeRequest): LogMeta {
  const forwarded = header(req, "x-forwarded-for");
  const route = req.route?.path;
  return {
    requestId: req.logsetuRequestId,
    method: req.method,
    path: pathOf(req),
    ...(typeof route === "string" ? { route } : {}),
    ip: forwarded?.split(",")[0]?.trim() || req.ip || req.socket?.remoteAddress,
    userAgent: header(req, "user-agent"),
  };
}

/**
 * Express middleware: gives every request a `req.logsetu` child logger tagged with a request id, method and
 * path, optionally logs each request, and reports 5xx responses. Register it before your routes.
 *
 * @example
 * import { LogSetu } from "logsetu-js";
 * import { logsetuMiddleware, logsetuErrorHandler } from "logsetu-js/express";
 * LogSetu.init({ apiKey: process.env.LOGSETU_API_KEY!, endpoint: process.env.LOGSETU_ENDPOINT!, source: "express-api" });
 * app.use(logsetuMiddleware({ logRequests: true }));
 * // ...routes...
 * app.use(logsetuErrorHandler());
 */
export function logsetuMiddleware(options: ExpressOptions = {}) {
  const { logRequests = false, capture5xx = true, ignorePaths = [] } = options;
  return (req: ExpressLikeRequest, res: ExpressLikeResponse, next: NextFunction): void => {
    const path = pathOf(req);
    if (ignorePaths.some((p) => (typeof p === "string" ? p === path : p.test(path)))) return next();

    const client = options.client ?? LogSetu.get();
    const started = Date.now();
    req.logsetuRequestId = header(req, "x-request-id") || randomId();
    const extra = typeof options.meta === "function" ? options.meta(req) : options.meta;
    req.logsetu = client.child({ requestId: req.logsetuRequestId, method: req.method, path, ...(extra ?? {}) });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const status = res.statusCode;
      const meta = { ...requestMeta(req), ...(extra ?? {}), status, durationMs: Date.now() - started };
      const reported = (req as unknown as Record<symbol, unknown>)[REPORTED];
      if (capture5xx && status >= 500 && !reported) {
        client.error(`HTTP ${status} on ${req.method} ${path}`, meta);
      } else if (logRequests) {
        client.log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", `${req.method} ${path} ${status}`, meta);
      }
    };
    res.on("finish", finish);
    res.on("close", finish);
    next();
  };
}

/**
 * Express error-handling middleware: reports the error with request context, then passes it on to the next
 * error handler (Express' default one renders the 500). Register it after your routes.
 */
export function logsetuErrorHandler(options: Pick<ExpressOptions, "client" | "meta"> = {}) {
  return (err: unknown, req: ExpressLikeRequest, _res: ExpressLikeResponse, next: NextFunction): void => {
    try {
      // req.logsetu (set by logsetuMiddleware) already carries the request id and the middleware's `meta`.
      const client = req.logsetu ?? options.client ?? LogSetu.get();
      const extra = typeof options.meta === "function" ? options.meta(req) : options.meta;
      const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
      // Client errors raised via http-errors (404, 400, …) are expected; don't page anyone for them.
      if (typeof status === "number" && status < 500) return next(err);
      client.captureException(err, { ...requestMeta(req), ...(extra ?? {}) });
      (req as unknown as Record<symbol, unknown>)[REPORTED] = true;
    } catch {
      /* never break the error pipeline */
    }
    next(err);
  };
}
