import type { LogEntry, LogLevel, LogMeta, LogSetuOptions } from "./types";
import { errorToMessage, isError, safeMeta, serializeError } from "./serialize";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

export const isBrowser = (): boolean => typeof window !== "undefined" && typeof document !== "undefined";

function detectEnvironment(): string {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.NODE_ENV || "production";
  } catch {
    return "production";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class LogSetuClient {
  private readonly opts: Required<
    Pick<LogSetuOptions, "environment" | "source" | "level" | "flushInterval" | "batchSize" | "maxQueueSize" | "maxRetries" | "enabled" | "console" | "debug">
  > &
    LogSetuOptions;
  private readonly ingestUrl: string;
  private queue: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private closed = false;
  private warnedOnce = false;
  private context: LogMeta;

  constructor(options: LogSetuOptions) {
    if (!options || !options.apiKey) console.warn("[logsetu] apiKey is missing; logs will not be sent");
    if (!options || !options.endpoint) console.warn("[logsetu] endpoint is missing; logs will not be sent");
    this.opts = {
      environment: detectEnvironment(),
      source: isBrowser() ? "browser" : "node",
      level: "debug",
      flushInterval: 2000,
      batchSize: 10,
      maxQueueSize: 1000,
      maxRetries: 3,
      enabled: true,
      console: false,
      debug: false,
      ...options,
    };
    this.context = { ...(options.defaultMeta ?? {}) };
    this.ingestUrl = `${(options.endpoint ?? "").replace(/\/+$/, "")}/api/v1/ingest`;
    this.installLifecycleHooks();
  }

  // ---------- public API ----------

  debug(message: string, meta?: LogMeta) {
    this.log("debug", message, meta);
  }
  info(message: string, meta?: LogMeta) {
    this.log("info", message, meta);
  }
  warn(message: string, meta?: LogMeta) {
    this.log("warn", message, meta);
  }
  error(message: string, meta?: LogMeta) {
    this.log("error", message, meta);
  }
  fatal(message: string, meta?: LogMeta) {
    this.log("fatal", message, meta);
  }

  log(level: LogLevel, message: string, meta?: LogMeta) {
    if (!this.opts.enabled || this.closed) return;
    if (LEVEL_RANK[level] < LEVEL_RANK[this.opts.level]) return;

    const merged: LogMeta = { ...this.context, ...(meta ?? {}) };
    // Common convenience: logger.error("msg", { error: err }) → flatten stack/name into meta
    const err = merged.error ?? merged.err;
    if (isError(err)) {
      const s = serializeError(err);
      if (!merged.stack && s.stack) merged.stack = s.stack;
      if (!merged.errorName) merged.errorName = s.name;
      merged.error = s;
      delete merged.err;
    }

    let entry: LogEntry = {
      level,
      message: String(message),
      source: this.opts.source,
      environment: this.opts.environment,
      timestamp: new Date().toISOString(),
      meta: safeMeta(merged),
    };
    if (this.opts.beforeSend) {
      const next = this.opts.beforeSend(entry);
      if (!next) return;
      entry = next;
    }
    if (this.opts.console) this.echo(entry);
    this.enqueue(entry);
  }

  /** Report an exception (any thrown value) as an error-level log with stack trace. */
  captureException(error: unknown, meta?: LogMeta, level: LogLevel = "error") {
    const details = isError(error) ? serializeError(error) : { value: error };
    this.log(level, errorToMessage(error), { ...details, ...(meta ?? {}) });
  }

  /** Merge metadata into every subsequent log from this client (e.g. user or tenant ids). */
  setContext(meta: LogMeta) {
    Object.assign(this.context, meta);
  }

  /** A logger that shares this client's queue but adds its own metadata (and optionally source). */
  child(meta: LogMeta, overrides: { source?: string } = {}): LogSetuClient {
    const parent = this;
    const child = Object.create(parent) as LogSetuClient;
    Object.defineProperty(child, "context", { value: { ...parent.context, ...meta }, writable: true });
    if (overrides.source) {
      Object.defineProperty(child, "opts", { value: { ...parent.opts, source: overrides.source } });
    }
    return child;
  }

  /** Send everything queued right now. Resolves when the network call finishes. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, 500);
    this.inflight = this.send(batch).finally(() => {
      this.inflight = null;
    });
    await this.inflight;
    if (this.queue.length > 0) await this.flush();
  }

  /** Flush and stop background timers. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  get pending(): number {
    return this.queue.length;
  }

  // ---------- internals ----------

  private enqueue(entry: LogEntry) {
    this.queue.push(entry);
    if (this.queue.length > this.opts.maxQueueSize) this.queue.splice(0, this.queue.length - this.opts.maxQueueSize);
    if (this.queue.length >= this.opts.batchSize) {
      void this.flush().catch(() => {});
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {});
      }, this.opts.flushInterval);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private async send(batch: LogEntry[], attempt = 0): Promise<void> {
    if (!this.opts.apiKey || !this.opts.endpoint) return;
    const f = this.opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      this.diag("fetch is not available in this environment");
      return;
    }
    try {
      const res = await f(this.ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(batch),
        keepalive: true,
      });
      if (res.ok) return;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      this.diag(`server rejected batch (HTTP ${res.status}); dropping ${batch.length} logs`);
    } catch (e) {
      if (attempt < this.opts.maxRetries) {
        await sleep(Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250);
        return this.send(batch, attempt + 1);
      }
      this.diag(`giving up after ${attempt + 1} attempts: ${errorToMessage(e)}`);
    }
  }

  /** Best-effort synchronous flush for page unload (sendBeacon can't set headers, so the key goes in the query). */
  private beacon() {
    if (this.queue.length === 0 || !this.opts.apiKey) return;
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (!nav?.sendBeacon) {
      void this.flush().catch(() => {});
      return;
    }
    const batch = this.queue.splice(0, 500);
    const url = `${this.ingestUrl}?apiKey=${encodeURIComponent(this.opts.apiKey)}`;
    // text/plain avoids a CORS preflight, which cannot complete during unload.
    const ok = nav.sendBeacon(url, new Blob([JSON.stringify(batch)], { type: "text/plain" }));
    if (!ok) this.queue.unshift(...batch);
  }

  private installLifecycleHooks() {
    if (isBrowser()) {
      const onHide = () => {
        if (document.visibilityState === "hidden") this.beacon();
      };
      document.addEventListener("visibilitychange", onHide);
      window.addEventListener("pagehide", () => this.beacon());
    } else {
      const proc = (globalThis as { process?: { on?: (event: string, cb: () => void) => void } }).process;
      if (proc?.on) {
        proc.on("beforeExit", () => {
          if (this.queue.length > 0) void this.flush().catch(() => {});
        });
      }
    }
  }

  private echo(e: LogEntry) {
    const fn = e.level === "debug" ? console.debug : e.level === "info" ? console.info : e.level === "warn" ? console.warn : console.error;
    fn(`[${e.level}] ${e.message}`, e.meta ?? "");
  }

  private diag(msg: string) {
    if (this.opts.debug) console.warn(`[logsetu] ${msg}`);
    else if (!this.warnedOnce) {
      this.warnedOnce = true;
      console.warn(`[logsetu] ${msg} (further transport warnings suppressed; set debug: true to see them)`);
    }
  }
}
