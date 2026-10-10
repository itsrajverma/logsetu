import { LogSetu, LogSetuClient, type LogMeta } from "./index";

export { LogSetu, LogSetuClient };

// Minimal structural types so the SDK doesn't depend on `hono` (Hono v3 and v4).
export interface HonoLikeContext {
  req: { method: string; url: string; path: string; routePath?: string; header(name: string): string | undefined };
  res: { status: number };
  error?: unknown;
  set(key: string, value: unknown): void;
  /** Throws on runtimes without an ExecutionContext (Node, Bun), hence the try/catch below. */
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}
export type HonoNext = () => Promise<void>;

export interface HonoOptions {
  /** Client to use. Defaults to `LogSetu.get()` (the client created by `LogSetu.init`). */
  client?: LogSetuClient;
  /** Emit an info log per completed request (method, path, status, duration). Default false. */
  logRequests?: boolean;
  /** Report responses with status >= 500 even when nothing was thrown. Default true. */
  capture5xx?: boolean;
  /** Extra metadata for every log, or a function of the context (e.g. tenant id). */
  meta?: LogMeta | ((c: HonoLikeContext) => LogMeta | undefined);
  /** Request paths to skip entirely, e.g. ["/healthz"]. */
  ignorePaths?: (string | RegExp)[];
  /**
   * Flush after every request that produced a log. On Cloudflare Workers / Vercel Edge this uses
   * `executionCtx.waitUntil` so the response isn't delayed. Default: true when an ExecutionContext exists.
   */
  flush?: boolean;
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

function executionCtx(c: HonoLikeContext) {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Hono middleware: reports thrown errors and 5xx responses with request context, optionally logs every
 * request, and exposes a request-scoped logger as `c.get("logsetu")`. Works on Node, Bun, Deno and Workers.
 *
 * @example
 * import { Hono } from "hono";
 * import { LogSetu } from "logsetu-js";
 * import { logsetu } from "logsetu-js/hono";
 * const app = new Hono();
 * app.use(logsetu({ client: LogSetu.init({ apiKey: env.LOGSETU_API_KEY, endpoint: env.LOGSETU_ENDPOINT, source: "hono-api" }) }));
 * app.get("/", (c) => { c.get("logsetu").info("hello"); return c.text("ok"); });
 */
export function logsetu(options: HonoOptions = {}) {
  const { logRequests = false, capture5xx = true, ignorePaths = [] } = options;
  return async (c: HonoLikeContext, next: HonoNext): Promise<void> => {
    const path = c.req.path;
    if (ignorePaths.some((p) => (typeof p === "string" ? p === path : p.test(path)))) return next();

    const client = options.client ?? LogSetu.get();
    const started = Date.now();
    const requestId = c.req.header("x-request-id") || randomId();
    const extra = typeof options.meta === "function" ? options.meta(c) : options.meta;
    c.set("logsetu", client.child({ requestId, method: c.req.method, path, ...(extra ?? {}) }));

    let thrown: unknown;
    try {
      await next();
    } catch (err) {
      thrown = err; // only reached when Hono's own error handling is bypassed (e.g. nested compose)
    }

    const error = thrown ?? c.error;
    const status = thrown ? 500 : c.res.status;
    const forwarded = c.req.header("x-forwarded-for");
    const meta: LogMeta = {
      requestId,
      method: c.req.method,
      path,
      ...(c.req.routePath && c.req.routePath !== "/*" ? { route: c.req.routePath } : {}),
      status,
      durationMs: Date.now() - started,
      ip: forwarded?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || c.req.header("x-real-ip"),
      userAgent: c.req.header("user-agent"),
      ...(extra ?? {}),
    };
    const httpStatus = (error as { status?: unknown } | null | undefined)?.status;
    if (error && !(typeof httpStatus === "number" && httpStatus < 500)) {
      client.captureException(error, meta);
    } else if (capture5xx && status >= 500) {
      client.error(`HTTP ${status} on ${c.req.method} ${path}`, meta);
    } else if (logRequests) {
      client.log(status >= 400 ? "warn" : "info", `${c.req.method} ${path} ${status}`, meta);
    }

    const ctx = executionCtx(c);
    if ((options.flush ?? Boolean(ctx)) && client.pending > 0) {
      const flushing = client.flush().catch(() => {});
      if (ctx) ctx.waitUntil(flushing);
      else await flushing;
    }
    if (thrown) throw thrown;
  };
}
