import type { LogMeta } from "./types";

export function isError(v: unknown): v is Error {
  return v instanceof Error || (typeof v === "object" && v !== null && "message" in v && "stack" in v);
}

export function serializeError(err: Error): LogMeta {
  const out: LogMeta = { name: err.name, message: err.message };
  if (err.stack) out.stack = err.stack;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = isError(cause) ? serializeError(cause) : safe(cause);
  for (const key of Object.keys(err)) {
    if (!(key in out)) out[key] = safe((err as unknown as Record<string, unknown>)[key]);
  }
  return out;
}

/** Make a value JSON-safe: errors, bigints, dates, circular refs, depth limit. */
export function safe(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return value.toString();
  if (t === "function" || t === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (isError(value)) return serializeError(value);
  if (t === "object") {
    if (depth > 6) return "[Object]";
    const obj = value as object;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    if (Array.isArray(obj)) return obj.slice(0, 200).map((v) => safe(v, depth + 1, seen));
    const out: LogMeta = {};
    for (const [k, v] of Object.entries(obj)) {
      const s = safe(v, depth + 1, seen);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return String(value);
}

export function safeMeta(meta: LogMeta | undefined): LogMeta | undefined {
  if (!meta) return undefined;
  const out = safe(meta) as LogMeta;
  return Object.keys(out).length ? out : undefined;
}

export function errorToMessage(err: unknown): string {
  if (isError(err)) return err.message || err.name || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
