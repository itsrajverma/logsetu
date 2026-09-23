import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dbFile = path.join(__dirname, "grouping-test.db");
// Set before anything imports lib/db (static imports are hoisted, so app modules are imported lazily below).
process.env.DATABASE_URL = `file:${dbFile}`;
const grouping = () => import("@/lib/grouping");

beforeAll(() => {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  execFileSync("node", [path.join(__dirname, "..", "scripts", "migrate.mjs")], { env: process.env, stdio: "ignore" });
});

afterAll(async () => {
  const { db } = await import("@/lib/db");
  await db.$disconnect();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
});

const jsStack = (line: number, id: number) => `TypeError: Cannot read properties of undefined (reading 'id${id}')
    at getUser (/app/.next/server/chunks/lib-3f2a9c1b.js:${line}:17)
    at async handler (/app/.next/server/app/api/users/route.js:${line + 10}:5)
    at async /app/node_modules/next/dist/server/base-server.js:900:3`;

const pyStack = (line: number) => `Traceback (most recent call last):
  File "/srv/venv/lib/python3.12/site-packages/django/core/handlers/base.py", line 197, in _get_response
    response = wrapped_callback(request, *callback_args, **callback_kwargs)
  File "/srv/app/billing/views.py", line ${line}, in charge
    return amount / quantity
ZeroDivisionError: division by zero`;

describe("fingerprinting", () => {
  it("parses V8 and Python frames innermost-first, ignoring line numbers and bundle hashes", async () => {
    const { exceptionType, parseFrames } = await grouping();
    expect(parseFrames(jsStack(10, 1))[0]).toEqual({ fn: "getUser", file: "chunks/lib.js" });
    expect(parseFrames(pyStack(12))[0]).toEqual({ fn: "charge", file: "billing/views.py" });
    expect(exceptionType(pyStack(12), {})).toBe("ZeroDivisionError");
    expect(exceptionType(jsStack(1, 1), {})).toBe("TypeError");
  });

  it("groups the same stack across deploys, separates different sources and code paths", async () => {
    const { fingerprintLog } = await grouping();
    const a = fingerprintLog({ level: "error", message: "boom 1", source: "web", meta: { stack: jsStack(10, 1) } });
    const b = fingerprintLog({ level: "error", message: "boom 2", source: "web", meta: { stack: jsStack(99, 2) } });
    const otherSource = fingerprintLog({ level: "error", message: "boom", source: "worker", meta: { stack: jsStack(10, 1) } });
    const py1 = fingerprintLog({ level: "error", message: "x", source: "api", meta: { stack: pyStack(12) } });
    const py2 = fingerprintLog({ level: "error", message: "y", source: "api", meta: { stack: pyStack(40) } });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(otherSource.fingerprint);
    expect(py1.fingerprint).toBe(py2.fingerprint);
    expect(a.culprit).toBe("getUser (chunks/lib.js)");
    expect(py1.culprit).toBe("charge (billing/views.py)"); // skips the site-packages frame
  });

  it("normalizes variable parts of stackless messages", async () => {
    const { fingerprintLog, normalizeMessage } = await grouping();
    expect(normalizeMessage(`User 42 not found (id=8a1b2c3d-1111-2222-3333-444455556666, email a@b.io)`)).toBe(
      "User <n> not found (id=<uuid>, email <email>)",
    );
    const x = fingerprintLog({ level: "error", message: "Timeout after 3000ms calling 'payments'", source: "api" });
    const y = fingerprintLog({ level: "error", message: "Timeout after 5000ms calling 'ledger'", source: "api" });
    expect(x.fingerprint).toBe(y.fingerprint);
  });

  it("honours meta.fingerprint overrides", async () => {
    const { fingerprintLog } = await grouping();
    const x = fingerprintLog({ level: "error", message: "a", source: "s", meta: { fingerprint: ["checkout", "stripe"] } });
    const y = fingerprintLog({ level: "error", message: "b", source: "s", meta: { fingerprint: ["checkout", "stripe"] } });
    expect(x.fingerprint).toBe(y.fingerprint);
  });
});

describe("assignIssues", () => {
  it("creates, counts, reopens on regression and leaves non-errors ungrouped", async () => {
    const { db } = await import("@/lib/db");
    const { assignIssues } = await import("@/lib/grouping");
    const p = await db.project.create({ data: { name: "g", apiKey: "kg" } });

    const batch = [
      { level: "error", message: "boom", source: "web", meta: { stack: jsStack(1, 1) }, timestamp: new Date() },
      { level: "fatal", message: "boom", source: "web", meta: { stack: jsStack(2, 2) }, timestamp: new Date() },
      { level: "info", message: "fine", source: "web" },
    ] as { level: string; message: string; source: string; meta?: unknown; timestamp?: Date; issueId?: string | null }[];
    const first = await assignIssues(p.id, batch);
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("new");
    expect(first[0]!.issue.count).toBe(2);
    expect(first[0]!.issue.level).toBe("fatal");
    expect(batch[0]!.issueId).toBe(first[0]!.issue.id);
    expect(batch[2]!.issueId).toBeUndefined();

    await db.issue.update({ where: { id: first[0]!.issue.id }, data: { status: "resolved", resolvedAt: new Date() } });
    const again = await assignIssues(p.id, [{ level: "error", message: "boom", source: "web", meta: { stack: jsStack(3, 3) } }]);
    expect(again[0]!.kind).toBe("regression");
    const reopened = await db.issue.findUniqueOrThrow({ where: { id: first[0]!.issue.id } });
    expect(reopened.status).toBe("open");
    expect(reopened.count).toBe(3);

    await db.issue.update({ where: { id: reopened.id }, data: { status: "ignored" } });
    const ignored = await assignIssues(p.id, [{ level: "error", message: "boom", source: "web", meta: { stack: jsStack(4, 4) } }]);
    expect(ignored[0]!.kind).toBe("existing");
    expect((await db.issue.findUniqueOrThrow({ where: { id: reopened.id } })).status).toBe("ignored");
  });

  it("lists issues with status counts and filters logs by issue", async () => {
    const { db } = await import("@/lib/db");
    const { queryIssues } = await import("@/lib/issues");
    const { queryLogs } = await import("@/lib/logs");
    const { assignIssues } = await import("@/lib/grouping");
    const p = await db.project.create({ data: { name: "q", apiKey: "kq" } });
    const rows = [
      { projectId: p.id, level: "error", message: "Order 1 failed", source: "api" },
      { projectId: p.id, level: "error", message: "Order 2 failed", source: "api" },
      { projectId: p.id, level: "error", message: "Disk full", source: "api" },
    ] as { projectId: string; level: string; message: string; source: string; issueId?: string | null }[];
    await assignIssues(p.id, rows);
    await db.logEntry.createMany({ data: rows });

    const res = await queryIssues({ projectId: p.id, status: "open", sort: "count", page: 1, limit: 50 });
    expect(res.issues.map((i) => [i.title, i.count, i.last24h])).toEqual([
      ["Order 1 failed", 2, 2],
      ["Disk full", 1, 1],
    ]);
    expect(res.counts).toEqual({ open: 2, resolved: 0, ignored: 0 });

    const logs = await queryLogs({ projectId: p.id, issueId: res.issues[0]!.id, page: 1, limit: 50, from: undefined, to: undefined });
    expect(logs.total).toBe(2);
  });
});
