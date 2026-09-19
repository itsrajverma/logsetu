import { LogSetuClient } from "./client";
import type { LogLevel, LogMeta, LogSetuOptions } from "./types";

export { LogSetuClient } from "./client";
export type { LogEntry, LogLevel, LogMeta, LogSetuOptions } from "./types";
export { serializeError } from "./serialize";

const GLOBAL_KEY = "__logsetu__";
type Slots = { default?: LogSetuClient; primary?: LogSetuClient; noop?: LogSetuClient };

function slots(): Slots {
  const g = globalThis as { [GLOBAL_KEY]?: Slots };
  return (g[GLOBAL_KEY] ??= {});
}

/**
 * Register a client that wins over `LogSetu.init` for `LogSetu.get()`. Used by the Next.js
 * `instrumentation.ts` helper: "use client" modules are also evaluated during SSR, so their
 * `init` call must not replace the server's client.
 * @internal
 */
export function setPrimaryClient(client: LogSetuClient | null) {
  slots().primary = client ?? undefined;
}

function fallback(): LogSetuClient {
  const s = slots();
  if (s.primary) return s.primary;
  if (s.default) return s.default;
  return (s.noop ??= new LogSetuClient({ apiKey: "", endpoint: "", enabled: false }));
}

export const LogSetu = {
  /**
   * Create the default client. Safe to call multiple times (e.g. across Next.js hot reloads);
   * the latest options win.
   */
  init(options: LogSetuOptions): LogSetuClient {
    const client = new LogSetuClient(options);
    slots().default = client;
    return client;
  },
  /** The active client: the server-registered one, else the last `init`, else a disabled placeholder. */
  get(): LogSetuClient {
    return fallback();
  },
  debug: (message: string, meta?: LogMeta) => fallback().debug(message, meta),
  info: (message: string, meta?: LogMeta) => fallback().info(message, meta),
  warn: (message: string, meta?: LogMeta) => fallback().warn(message, meta),
  error: (message: string, meta?: LogMeta) => fallback().error(message, meta),
  fatal: (message: string, meta?: LogMeta) => fallback().fatal(message, meta),
  log: (level: LogLevel, message: string, meta?: LogMeta) => fallback().log(level, message, meta),
  captureException: (error: unknown, meta?: LogMeta) => fallback().captureException(error, meta),
  setContext: (meta: LogMeta) => fallback().setContext(meta),
  flush: () => fallback().flush(),
};

