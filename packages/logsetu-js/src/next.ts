import { LogSetu, LogSetuClient, setPrimaryClient, type LogMeta, type LogSetuOptions } from "./index";

export { LogSetu, LogSetuClient };

type Proc = {
  env?: Record<string, string | undefined>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  exit?: (code?: number) => void;
};
const proc = (): Proc | undefined => (globalThis as { process?: Proc }).process;

const REPORTED = "__logsetu_reported__";
function markReported(err: unknown) {
  if (err && typeof err === "object") {
    try {
      Object.defineProperty(err, REPORTED, { value: true, enumerable: false });
    } catch {
      /* frozen */
    }
  }
}
function isReported(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as Record<string, unknown>)[REPORTED]);
}

export interface RegisterOptions extends LogSetuOptions {
  /** Report unhandled promise rejections. Default true. */
  captureUnhandledRejections?: boolean;
  /** Report uncaught exceptions, flush, then exit(1) like Node would have. Default true. */
  captureUncaughtExceptions?: boolean;
}

/**
 * Call from `instrumentation.ts` → `register()` to initialise LogSetu on the server
 * and capture unhandled errors. No-ops outside the Node.js runtime (edge/browser).
 *
 * @example
 * // instrumentation.ts
 * import { registerLogSetu } from "logsetu-js/next";
 * export function register() {
 *   registerLogSetu({ apiKey: process.env.LOGSETU_API_KEY!, endpoint: process.env.LOGSETU_ENDPOINT! });
 * }
 */
export function registerLogSetu(options: RegisterOptions): LogSetuClient | null {
  const p = proc();
  const runtime = p?.env?.NEXT_RUNTIME;
  if (runtime && runtime !== "nodejs") return null;
  if (!p?.on) return null;

  const { captureUnhandledRejections = true, captureUncaughtExceptions = true, ...rest } = options;
  const client = new LogSetuClient({ source: "nextjs-server", ...rest });
  setPrimaryClient(client);

  const g = globalThis as { __logsetu_next_hooks__?: boolean };
  if (!g.__logsetu_next_hooks__) {
    g.__logsetu_next_hooks__ = true;
    if (captureUnhandledRejections) {
      p.on("unhandledRejection", (reason) => {
        LogSetu.get().captureException(reason, { kind: "unhandledRejection" });
      });
    }
    if (captureUncaughtExceptions) {
      p.on("uncaughtException", (err) => {
        const c = LogSetu.get();
        c.captureException(err, { kind: "uncaughtException" }, "fatal");
        void c.flush().finally(() => p.exit?.(1));
      });
    }
  }
  return client;
}

// Mirrors Next.js' `onRequestError` instrumentation hook types without importing `next`.
export interface NextRequestErrorInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}
export interface NextRequestErrorContext {
  routerKind: string;
  routePath: string;
  routeType: string;
  renderSource?: string;
  revalidateReason?: string;
  renderType?: string;
}

/**
 * Build an `onRequestError` hook for `instrumentation.ts`. Captures errors thrown from
 * Server Components, Route Handlers, Server Actions and middleware.
 *
 * @example
 * export const onRequestError = createOnRequestError();
 */
export function createOnRequestError(client?: LogSetuClient, extraMeta?: LogMeta) {
  return async (
    error: unknown,
    request: NextRequestErrorInfo,
    context: NextRequestErrorContext,
  ): Promise<void> => {
    const c = client ?? LogSetu.get();
    if (isReported(error)) {
      await c.flush(); // already captured by withLogSetu; just make sure it leaves the process
      return;
    }
    c.captureException(error, {
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
      ...(context.renderSource ? { renderSource: context.renderSource } : {}),
      digest: (error as { digest?: string })?.digest,
      userAgent: headerValue(request.headers["user-agent"]),
      ...(extraMeta ?? {}),
    });
    await c.flush();
  };
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

type RouteHandler<Ctx> = (req: Request, ctx: Ctx) => Response | Promise<Response>;

/**
 * Wrap a Route Handler so thrown errors are reported (with method, URL and duration) and re-thrown.
 * Pass `{ logRequests: true }` to also emit an info log per request.
 */
export function withLogSetu<Ctx = unknown>(
  handler: RouteHandler<Ctx>,
  options: { client?: LogSetuClient; logRequests?: boolean; meta?: LogMeta } = {},
): RouteHandler<Ctx> {
  return async (req, ctx) => {
    const c = options.client ?? LogSetu.get();
    const started = Date.now();
    const base = { method: req.method, url: req.url, ...(options.meta ?? {}) };
    try {
      const res = await handler(req, ctx);
      if (options.logRequests) {
        c.info(`${req.method} ${new URL(req.url).pathname} ${res.status}`, { ...base, status: res.status, durationMs: Date.now() - started });
      }
      return res;
    } catch (err) {
      c.captureException(err, { ...base, durationMs: Date.now() - started });
      markReported(err);
      await c.flush().catch(() => {}); // errors are rare; make sure they survive serverless freezes
      throw err;
    }
  };
}
