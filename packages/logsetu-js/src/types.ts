export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogMeta = Record<string, unknown>;

export interface LogEntry {
  level: LogLevel;
  message: string;
  source: string;
  environment: string;
  timestamp: string;
  meta?: LogMeta;
}

export interface LogSetuOptions {
  /** Project API key from the LogSetu dashboard. */
  apiKey: string;
  /** Base URL of your LogSetu server, e.g. "https://logs.example.com". */
  endpoint: string;
  /** Tag every log with an environment. Defaults to NODE_ENV or "production". */
  environment?: string;
  /** Tag every log with a source, e.g. "nextjs-web". Defaults to "browser" or "node". */
  source?: string;
  /** Minimum level to send. Defaults to "debug". */
  level?: LogLevel;
  /** Metadata merged into every log (e.g. { tenant_id: "acme" }). */
  defaultMeta?: LogMeta;
  /** Flush the queue this often (ms). Default 2000. */
  flushInterval?: number;
  /** Flush as soon as this many logs are queued. Default 10. */
  batchSize?: number;
  /** Drop oldest logs beyond this queue length. Default 1000. */
  maxQueueSize?: number;
  /** Retries per batch with exponential backoff. Default 3. */
  maxRetries?: number;
  /** Set false to turn the SDK into a no-op (e.g. in tests). Default true. */
  enabled?: boolean;
  /** Also print logs to the console. Default false. */
  console?: boolean;
  /** Print SDK diagnostics (transport failures) to the console. Default false. */
  debug?: boolean;
  /** Modify or drop a log before it is queued. Return null to drop. */
  beforeSend?: (entry: LogEntry) => LogEntry | null;
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}
