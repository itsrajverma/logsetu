import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import type { LogRecord } from "@/lib/logs";

const dbFile = path.join(__dirname, "otlp-test.db");
// Set before anything imports lib/db (app modules are imported lazily below).
process.env.DATABASE_URL = `file:${dbFile}`;

type ExportBody = { resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[] };
const requests: { url: string; headers: http.IncomingHttpHeaders; body: ExportBody }[] = [];
let failures = 0;
const collector = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (failures > 0) {
      failures -= 1;
      res.writeHead(503).end();
      return;
    }
    requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(data) as ExportBody });
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
});
let endpoint = "";

beforeAll(async () => {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  execFileSync("node", [path.join(__dirname, "..", "scripts", "migrate.mjs")], { env: process.env, stdio: "ignore" });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

afterAll(async () => {
  collector.close();
  const { stopOtlpExporter } = await import("@/lib/otlp");
  await stopOtlpExporter();
  const { db } = await import("@/lib/db");
  await db.$disconnect();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
});

const log = (over: Partial<LogRecord> = {}): LogRecord => ({
  id: "log1",
  projectId: "p1",
  level: "error",
  message: "Payment failed",
  source: "checkout-api",
  environment: "production",
  meta: {
    stack: "Error: Payment failed\n    at pay (pay.js:1:1)",
    orderId: 42,
    amount: 9.99,
    retry: true,
    tags: ["a", "b"],
    user: { id: "u1" },
    traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
    span_id: "00f067aa0ba902b7",
  },
  timestamp: new Date("2026-09-20T10:00:00.123Z"),
  createdAt: new Date("2026-09-20T10:00:01Z"),
  issueId: "iss1",
  ...over,
});

describe("OTLP encoding", () => {
  it("maps a log to an OTLP LogRecord", async () => {
    const { toLogRecord } = await import("@/lib/otlp");
    const r = toLogRecord(log());
    expect(r).toMatchObject({
      timeUnixNano: "1789898400123000000",
      severityNumber: 17,
      severityText: "ERROR",
      body: { stringValue: "Payment failed" },
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const attrs = Object.fromEntries(r.attributes.map((a) => [a.key, a.value]));
    expect(attrs["exception.stacktrace"]).toEqual({ stringValue: "Error: Payment failed\n    at pay (pay.js:1:1)" });
    expect(attrs.orderId).toEqual({ intValue: "42" });
    expect(attrs.amount).toEqual({ doubleValue: 9.99 });
    expect(attrs.retry).toEqual({ boolValue: true });
    expect(attrs.tags).toEqual({ arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } });
    expect(attrs.user).toEqual({ kvlistValue: { values: [{ key: "id", value: { stringValue: "u1" } }] } });
    expect(attrs["logsetu.issue.id"]).toEqual({ stringValue: "iss1" });
    expect(attrs.traceId).toBeUndefined();
  });

  it("groups records into one resource per project/source/environment", async () => {
    const { buildExportRequest } = await import("@/lib/otlp");
    const req = buildExportRequest(
      [log(), log({ id: "log2" }), log({ id: "log3", source: "web", level: "warn" })],
      new Map([["p1", "acme-storefront"]]),
    );
    expect(req.resourceLogs).toHaveLength(2);
    const [api] = req.resourceLogs;
    expect(api!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "checkout-api" } });
    expect(api!.resource.attributes).toContainEqual({ key: "logsetu.project.name", value: { stringValue: "acme-storefront" } });
    expect(api!.scopeLogs[0]!.logRecords).toHaveLength(2);
  });

  it("parses env config", async () => {
    const { getOtlpConfig } = await import("@/lib/otlp");
    expect(getOtlpConfig({})).toBeNull();
    expect(
      getOtlpConfig({
        LOGSETU_OTLP_ENDPOINT: "https://otel.example.com:4318/",
        LOGSETU_OTLP_HEADERS: "Authorization=Bearer%20abc,x-tenant=acme",
        LOGSETU_OTLP_PROJECTS: "shop, web",
      }),
    ).toEqual({
      url: "https://otel.example.com:4318/v1/logs",
      headers: { Authorization: "Bearer abc", "x-tenant": "acme" },
      intervalMs: 2000,
      projects: ["shop", "web"],
    });
    expect(getOtlpConfig({ LOGSETU_OTLP_ENDPOINT: "http://c/v1/logs" })!.url).toBe("http://c/v1/logs");
  });
});

describe("OTLP exporter", () => {
  it("forwards published logs, retries 503s, and honours the project allowlist", async () => {
    const { db } = await import("@/lib/db");
    const { publishLogs } = await import("@/lib/events");
    const { startOtlpExporter, flushOtlp, getOtlpStatus } = await import("@/lib/otlp");
    const shop = await db.project.create({ data: { name: "shop", apiKey: "k1" } });
    const other = await db.project.create({ data: { name: "other", apiKey: "k2" } });

    await startOtlpExporter({ url: `${endpoint}/v1/logs`, headers: { "x-api-key": "secret" }, intervalMs: 60_000, projects: ["shop"] });
    failures = 1; // first attempt gets a retryable 503
    publishLogs(shop.id, [log({ projectId: shop.id })]);
    publishLogs(other.id, [log({ projectId: other.id, id: "hidden" })]);
    await flushOtlp();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/logs");
    expect(requests[0]!.headers["x-api-key"]).toBe("secret");
    const records = requests[0]!.body.resourceLogs.flatMap((r) => r.scopeLogs[0]!.logRecords);
    expect(records).toHaveLength(1);
    expect(getOtlpStatus()).toMatchObject({ enabled: true, exported: 1, dropped: 0, queued: 0, lastError: null });
  });
});
