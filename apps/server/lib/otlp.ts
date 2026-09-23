import { db } from "./db";
import { subscribeLogs } from "./events";
import type { LogRecord } from "./logs";

// OpenTelemetry export: forwards every ingested log to an OTLP/HTTP collector (JSON encoding, no SDK needed).
// Configure with LOGSETU_OTLP_ENDPOINT (base URL like http://otel-collector:4318, or a full …/v1/logs URL),
// optional LOGSETU_OTLP_HEADERS ("k1=v1,k2=v2") and LOGSETU_OTLP_PROJECTS (comma-separated project ids/names).

const SEVERITY: Record<string, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
  fatal: { number: 21, text: "FATAL" },
};

const MAX_BATCH = 512;
const MAX_QUEUE = 10_000;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 10_000;

export type OtlpConfig = {
  url: string;
  headers: Record<string, string>;
  intervalMs: number;
  projects: string[] | null; // ids or names; null = all
};

export function getOtlpConfig(env: Record<string, string | undefined> = process.env): OtlpConfig | null {
  const raw = env.LOGSETU_OTLP_ENDPOINT?.trim();
  if (!raw) return null;
  const base = raw.replace(/\/+$/, "");
  const url = /\/v1\/logs$/.test(base) ? base : `${base}/v1/logs`;
  const headers: Record<string, string> = {};
  for (const pair of (env.LOGSETU_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) headers[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  const interval = Number(env.LOGSETU_OTLP_INTERVAL_MS);
  const projects = (env.LOGSETU_OTLP_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    url,
    headers,
    intervalMs: Number.isFinite(interval) && interval >= 100 ? interval : 2000,
    projects: projects.length ? projects : null,
  };
}

// ---------- OTLP JSON encoding ----------

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }
  | { kvlistValue: { values: KeyValue[] } };
type KeyValue = { key: string; value: AnyValue };

export function toAnyValue(v: unknown, depth = 0): AnyValue {
  if (v === null || v === undefined) return { stringValue: "" };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === "bigint") return { intValue: v.toString() };
  if (depth >= 5) return { stringValue: JSON.stringify(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => toAnyValue(x, depth + 1)) } };
  if (typeof v === "object") {
    return {
      kvlistValue: { values: Object.entries(v as Record<string, unknown>).map(([key, x]) => ({ key, value: toAnyValue(x, depth + 1) })) },
    };
  }
  return { stringValue: String(v) };
}

const attr = (key: string, value: unknown): KeyValue => ({ key, value: toAnyValue(value) });

const HEX = (len: number) => new RegExp(`^[0-9a-f]{${len}}$`, "i");
function pickHex(meta: Record<string, unknown>, keys: string[], len: number): string | undefined {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && HEX(len).test(v.replace(/-/g, ""))) return v.replace(/-/g, "").toLowerCase();
  }
  return undefined;
}

const toNanos = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;

/** Convert one LogSetu log into an OTLP LogRecord. */
export function toLogRecord(log: LogRecord) {
  const meta = (log.meta && typeof log.meta === "object" && !Array.isArray(log.meta) ? log.meta : {}) as Record<string, unknown>;
  const sev = SEVERITY[log.level] ?? SEVERITY.info!;
  const traceId = pickHex(meta, ["traceId", "trace_id", "traceID"], 32);
  const spanId = pickHex(meta, ["spanId", "span_id", "spanID"], 16);

  const attributes: KeyValue[] = [attr("logsetu.log.id", log.id)];
  for (const [k, v] of Object.entries(meta)) {
    if (["traceId", "trace_id", "traceID", "spanId", "span_id", "spanID"].includes(k)) continue;
    if (k === "stack") attributes.push(attr("exception.stacktrace", v));
    else if (k === "exception" && typeof v === "string") attributes.push(attr("exception.type", v));
    else attributes.push(attr(k, v));
  }
  if (log.issueId) attributes.push(attr("logsetu.issue.id", log.issueId));

  return {
    timeUnixNano: toNanos(log.timestamp),
    observedTimeUnixNano: toNanos(log.createdAt),
    severityNumber: sev.number,
    severityText: sev.text,
    body: { stringValue: log.message },
    attributes,
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
  };
}

/** Build an ExportLogsServiceRequest, one resource per (project, source, environment). */
export function buildExportRequest(logs: LogRecord[], projectNames: Map<string, string>, version = "dev") {
  const resources = new Map<string, { attrs: KeyValue[]; records: ReturnType<typeof toLogRecord>[] }>();
  for (const log of logs) {
    const key = `${log.projectId}\u0000${log.source}\u0000${log.environment}`;
    let r = resources.get(key);
    if (!r) {
      r = {
        attrs: [
          attr("service.name", log.source),
          attr("deployment.environment.name", log.environment),
          attr("logsetu.project.id", log.projectId),
          attr("logsetu.project.name", projectNames.get(log.projectId) ?? log.projectId),
        ],
        records: [],
      };
      resources.set(key, r);
    }
    r.records.push(toLogRecord(log));
  }
  return {
    resourceLogs: [...resources.values()].map((r) => ({
      resource: { attributes: r.attrs },
      scopeLogs: [{ scope: { name: "logsetu", version }, logRecords: r.records }],
    })),
  };
}

// ---------- Exporter ----------

export type OtlpStatus = {
  enabled: boolean;
  url: string | null;
  queued: number;
  exported: number;
  dropped: number;
  failedBatches: number;
  lastSuccessAt: string | null;
  lastError: string | null;
};

type State = {
  config: OtlpConfig | null;
  queue: LogRecord[];
  timer?: ReturnType<typeof setInterval>;
  flushing: Promise<void> | null;
  names: Map<string, string>;
  allowed: Set<string> | null; // resolved project ids when LOGSETU_OTLP_PROJECTS is set
  status: Omit<OtlpStatus, "enabled" | "url" | "queued">;
  unsubscribe?: () => void;
};

const g = globalThis as { __logsetuOtlp?: State };
const state: State = (g.__logsetuOtlp ??= {
  config: null,
  queue: [],
  flushing: null,
  names: new Map(),
  allowed: null,
  status: { exported: 0, dropped: 0, failedBatches: 0, lastSuccessAt: null, lastError: null },
});

export function getOtlpStatus(): OtlpStatus {
  return {
    enabled: state.config !== null,
    url: state.config?.url ?? null,
    queued: state.queue.length,
    ...state.status,
  };
}

async function refreshProjects() {
  const projects = await db.project.findMany({ select: { id: true, name: true } });
  state.names = new Map(projects.map((p) => [p.id, p.name]));
  const wanted = state.config?.projects;
  state.allowed = wanted ? new Set(projects.filter((p) => wanted.includes(p.id) || wanted.includes(p.name)).map((p) => p.id)) : null;
}

function enqueue(logs: LogRecord[]) {
  // Drop known non-exported projects early; unknown (newly created) ones are resolved at flush time.
  const allowed = state.allowed;
  state.queue.push(...(allowed ? logs.filter((l) => allowed.has(l.projectId) || !state.names.has(l.projectId)) : logs));
  const overflow = state.queue.length - MAX_QUEUE;
  if (overflow > 0) {
    state.queue.splice(0, overflow); // drop oldest
    state.status.dropped += overflow;
  }
  if (state.queue.length >= MAX_BATCH) void flushOtlp();
}

async function post(cfg: OtlpConfig, body: unknown): Promise<void> {
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...cfg.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return;
      lastErr = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim();
      // Only 429/502/503/504 are retryable per the OTLP spec.
      if (![429, 502, 503, 504].includes(res.status)) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff(attempt));
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt));
    }
  }
  throw new Error(lastErr || "export failed");
}

const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 5000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send everything queued so far. Concurrent calls share one in-flight flush. */
export function flushOtlp(): Promise<void> {
  const cfg = state.config;
  if (!cfg) return Promise.resolve();
  if (state.flushing) return state.flushing;
  state.flushing = (async () => {
    while (state.queue.length > 0) {
      const taken = state.queue.splice(0, MAX_BATCH);
      if (taken.some((l) => !state.names.has(l.projectId))) await refreshProjects().catch(() => {});
      const batch = state.allowed ? taken.filter((l) => state.allowed!.has(l.projectId)) : taken;
      if (batch.length === 0) continue;
      try {
        await post(cfg, buildExportRequest(batch, state.names, process.env.LOGSETU_VERSION ?? "dev"));
        state.status.exported += batch.length;
        state.status.lastSuccessAt = new Date().toISOString();
        state.status.lastError = null;
      } catch (e) {
        state.status.failedBatches += 1;
        state.status.dropped += batch.length;
        state.status.lastError = (e as Error).message;
        console.error(`[logsetu] OTLP export of ${batch.length} logs failed: ${state.status.lastError}`);
      }
    }
  })().finally(() => {
    state.flushing = null;
  });
  return state.flushing;
}

/** Start forwarding (called from instrumentation.ts; no-op without LOGSETU_OTLP_ENDPOINT). */
export async function startOtlpExporter(config = getOtlpConfig()) {
  if (state.unsubscribe || !config) return;
  state.config = config;
  await refreshProjects().catch((e) => console.error("[logsetu] OTLP: could not load projects", e));
  const off = subscribeLogs("*", enqueue);
  state.timer = setInterval(() => void flushOtlp(), config.intervalMs);
  state.timer.unref?.();
  state.unsubscribe = () => {
    off();
    clearInterval(state.timer);
  };
  console.log(`[logsetu] exporting logs to OTLP collector at ${config.url}`);
}

/** Test helper: stop and reset. */
export async function stopOtlpExporter() {
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  await flushOtlp();
  state.config = null;
  state.queue = [];
  state.status = { exported: 0, dropped: 0, failedBatches: 0, lastSuccessAt: null, lastError: null };
}
