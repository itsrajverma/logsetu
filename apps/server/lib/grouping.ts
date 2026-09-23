import { createHash } from "node:crypto";
import { db } from "./db";

// Error grouping: error/fatal logs are fingerprinted and collapsed into Issues.
// Fingerprint = source + exception type + stack frames (function + file, no line numbers), or — when there is
// no stack — source + the message with variable parts (ids, numbers, quoted values…) normalized away.
// SDKs can override grouping by sending meta.fingerprint (string or string[]).

export const GROUPED_LEVELS = new Set(["error", "fatal"]);
export const ISSUE_STATUSES = ["open", "resolved", "ignored"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

const STACK_KEYS = ["stack", "stacktrace", "stack_trace", "traceback", "exc_text"];
const MAX_FRAMES = 10;

export type Frame = { fn: string; file: string };
export type Fingerprint = { fingerprint: string; title: string; culprit: string | null };

type GroupableLog = { level: string; message: string; source?: string | null; meta?: unknown };

function metaObject(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

export function extractStack(meta: unknown): string | null {
  const m = metaObject(meta);
  for (const k of STACK_KEYS) if (typeof m[k] === "string" && m[k]) return m[k] as string;
  // logger.error("msg", { error: err }) shapes
  for (const k of ["error", "err", "exception"]) {
    const nested = metaObject(m[k]);
    if (typeof nested.stack === "string" && nested.stack) return nested.stack;
  }
  return null;
}

/** Reduce a file path to something stable across deploys and machines. */
function normalizeFile(file: string): string {
  let f = file.replace(/[?#].*$/, "").replace(/\\/g, "/");
  f = f.replace(/^.*\/node_modules\//, "node_modules/");
  f = f.replace(/^(webpack|file|https?):\/+[^/]*/, "");
  f = f.split("/").slice(-2).join("/");
  // bundler content hashes: page-3f2a9c1b.js, chunk.8e1f2a.js
  return f.replace(/[.-][0-9a-f]{6,}(?=\.)/gi, "");
}

/** Parse V8 ("at fn (file:1:2)") and Python ('File "x.py", line 3, in fn') frames, innermost first. */
export function parseFrames(stack: string): Frame[] {
  const js: Frame[] = [];
  const py: Frame[] = [];
  for (const line of stack.split("\n")) {
    const v8 = /^\s*at\s+(?:(.*?)\s+\()?(.*?)(?::\d+)?(?::\d+)?\)?\s*$/.exec(line);
    if (v8 && /^\s*at\s/.test(line)) {
      js.push({ fn: (v8[1] ?? "<anonymous>").replace(/^async\s+/, ""), file: normalizeFile(v8[2] ?? "") });
      continue;
    }
    const p = /^\s*File "(.+?)", line \d+, in (.+?)\s*$/.exec(line);
    if (p) py.push({ fn: p[2]!, file: normalizeFile(p[1]!) });
  }
  // Python tracebacks list the innermost frame last.
  const frames = js.length >= py.length ? js : py.reverse();
  return frames.slice(0, MAX_FRAMES);
}

/** "TypeError: x is undefined" (V8, first line) or "ZeroDivisionError: …" (Python, last line). */
export function exceptionType(stack: string, meta: unknown): string {
  const m = metaObject(meta);
  for (const k of ["exception", "name", "errorType", "exc_type"]) {
    if (typeof m[k] === "string" && /^[\w.$]+$/.test(m[k] as string)) return m[k] as string;
  }
  const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
  const candidates = /^Traceback \(most recent call last\)/.test(lines[0] ?? "") ? [...lines].reverse() : lines;
  for (const l of candidates) {
    const t = /^([\w.$]+(?:Error|Exception|Exit|Interrupt|Warning)?)(?::|$)/.exec(l);
    if (t && !/^(at|File)$/.test(t[1]!)) return t[1]!;
  }
  return "Error";
}

/** Strip the variable parts of a message so "user 42 not found" and "user 97 not found" group together. */
export function normalizeMessage(message: string): string {
  return (message.split("\n")[0] ?? "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\bhttps?:\/\/\S+/g, "<url>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b(?:0x)?[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/(["'`]).*?\1/g, "<str>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function hash(parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}

export function fingerprintLog(log: GroupableLog): Fingerprint {
  const meta = metaObject(log.meta);
  const source = log.source ?? "unknown";
  const title = (log.message.split("\n")[0] ?? log.message).slice(0, 200);

  const custom = meta.fingerprint;
  if (typeof custom === "string" || (Array.isArray(custom) && custom.every((c) => typeof c === "string"))) {
    return { fingerprint: hash(["custom", source, ...([] as string[]).concat(custom as string | string[])]), title, culprit: null };
  }

  const stack = extractStack(meta);
  const frames = stack ? parseFrames(stack) : [];
  if (stack && frames.length > 0) {
    const type = exceptionType(stack, meta);
    const inApp = frames.find((f) => !f.file.startsWith("node_modules/") && !/site-packages|dist-packages/.test(f.file));
    const top = inApp ?? frames[0]!;
    return {
      fingerprint: hash(["stack", source, type, ...frames.map((f) => `${f.fn}@${f.file}`)]),
      title,
      culprit: `${top.fn} (${top.file})`,
    };
  }
  return { fingerprint: hash(["message", source, normalizeMessage(log.message)]), title, culprit: null };
}

const LEVEL_RANK: Record<string, number> = { error: 0, fatal: 1 };

export type IssueChange = {
  issue: { id: string; projectId: string; title: string; level: string; source: string; count: number; culprit: string | null };
  kind: "new" | "regression" | "existing";
  events: number;
};

type Row = { level: string; message: string; source?: string; meta?: unknown; timestamp?: Date | string; issueId?: string | null };

/**
 * Assign issueId on the error/fatal rows of an ingest batch (mutates rows), creating or updating issues.
 * Resolved issues that recur are reopened ("regression"); ignored issues stay ignored but keep counting.
 */
export async function assignIssues(projectId: string, rows: Row[]): Promise<IssueChange[]> {
  const groups = new Map<string, { fp: Fingerprint; rows: Row[] }>();
  for (const row of rows) {
    if (!GROUPED_LEVELS.has(row.level)) continue;
    const fp = fingerprintLog(row);
    const g = groups.get(fp.fingerprint) ?? { fp, rows: [] };
    g.rows.push(row);
    groups.set(fp.fingerprint, g);
  }

  const changes: IssueChange[] = [];
  for (const { fp, rows: grouped } of groups.values()) {
    const times = grouped.map((r) => (r.timestamp ? new Date(r.timestamp) : new Date()).getTime());
    const first = new Date(Math.min(...times));
    const last = new Date(Math.max(...times));
    const level = grouped.some((r) => r.level === "fatal") ? "fatal" : "error";
    const source = grouped[0]!.source ?? "unknown";

    const upsert = async (): Promise<IssueChange> => {
      const existing = await db.issue.findUnique({
        where: { projectId_fingerprint: { projectId, fingerprint: fp.fingerprint } },
      });
      if (!existing) {
        const issue = await db.issue.create({
          data: {
            projectId,
            fingerprint: fp.fingerprint,
            title: fp.title,
            culprit: fp.culprit,
            level,
            source,
            count: grouped.length,
            firstSeen: first,
            lastSeen: last,
          },
        });
        return { issue, kind: "new", events: grouped.length };
      }
      const regression = existing.status === "resolved";
      const issue = await db.issue.update({
        where: { id: existing.id },
        data: {
          count: { increment: grouped.length },
          lastSeen: last > existing.lastSeen ? last : existing.lastSeen,
          firstSeen: first < existing.firstSeen ? first : existing.firstSeen,
          level: (LEVEL_RANK[level] ?? 0) > (LEVEL_RANK[existing.level] ?? 0) ? level : existing.level,
          title: fp.title,
          ...(regression ? { status: "open", resolvedAt: null } : {}),
        },
      });
      return { issue, kind: regression ? "regression" : "existing", events: grouped.length };
    };

    let change: IssueChange;
    try {
      change = await upsert();
    } catch (e) {
      // Two concurrent batches created the same new issue; the loser retries as an update.
      if ((e as { code?: string }).code !== "P2002") throw e;
      change = await upsert();
    }
    for (const r of grouped) r.issueId = change.issue.id;
    changes.push(change);
  }
  return changes;
}
