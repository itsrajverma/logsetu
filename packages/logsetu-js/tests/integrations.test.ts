import type { AddressInfo } from "node:net";
import express from "express";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { LogSetuClient } from "../src/index";
import { logsetuErrorHandler, logsetuMiddleware } from "../src/express";
import { logsetu } from "../src/hono";
import type { LogEntry } from "../src/types";

function recordingClient(extra: Record<string, unknown> = {}) {
  const sent: LogEntry[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(...(JSON.parse(String(init?.body)) as LogEntry[]));
    return new Response(null, { status: 202 });
  });
  const client = new LogSetuClient({
    apiKey: "ls_test",
    endpoint: "http://logsetu.local",
    source: "test",
    fetch: fetchImpl as unknown as typeof fetch,
    ...extra,
  });
  return { client, sent };
}

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("logsetu-js/express", () => {
  it("reports thrown errors with request context and exposes req.logsetu", async () => {
    const { client, sent } = recordingClient();
    const app = express();
    app.use(logsetuMiddleware({ client, meta: (req) => ({ tenant: req.headers["x-tenant"] }) }));
    app.get("/ok", (req, res) => {
      req.logsetu.info("inside handler");
      res.send("ok");
    });
    app.get("/boom/:id", () => {
      throw new Error("kaboom");
    });
    app.use(logsetuErrorHandler({ client }));

    await withServer(app, async (base) => {
      expect((await fetch(`${base}/ok`, { headers: { "x-request-id": "req-1" } })).status).toBe(200);
      expect((await fetch(`${base}/boom/7`, { headers: { "x-tenant": "acme" } })).status).toBe(500);
    });
    await client.flush();

    expect(sent.map((l) => [l.level, l.message])).toEqual([
      ["info", "inside handler"],
      ["error", "kaboom"],
    ]);
    expect(sent[0]!.meta).toMatchObject({ requestId: "req-1", method: "GET", path: "/ok" });
    expect(sent[1]!.meta).toMatchObject({ method: "GET", path: "/boom/7", route: "/boom/:id", tenant: "acme", name: "Error" });
    expect(String(sent[1]!.meta!.stack)).toContain("kaboom");
  });

  it("logs requests, reports bare 5xx once, and skips ignored paths", async () => {
    const { client, sent } = recordingClient();
    const app = express();
    app.use(logsetuMiddleware({ client, logRequests: true, ignorePaths: ["/healthz"] }));
    app.get("/healthz", (_req, res) => res.send("ok"));
    app.get("/missing", (_req, res) => res.status(404).send("nope"));
    app.get("/down", (_req, res) => res.status(503).send("down"));

    await withServer(app, async (base) => {
      await fetch(`${base}/healthz`);
      await fetch(`${base}/missing`);
      await fetch(`${base}/down`);
    });
    await client.flush();

    expect(sent.map((l) => [l.level, l.message])).toEqual([
      ["warn", "GET /missing 404"],
      ["error", "HTTP 503 on GET /down"],
    ]);
    expect(sent[1]!.meta).toMatchObject({ status: 503 });
    expect(typeof sent[1]!.meta!.durationMs).toBe("number");
  });

  it("ignores 4xx http-errors in the error handler", async () => {
    const { client, sent } = recordingClient();
    const app = express();
    app.use(logsetuMiddleware({ client }));
    app.get("/bad", () => {
      throw Object.assign(new Error("Bad input"), { status: 400 });
    });
    app.use(logsetuErrorHandler({ client }));
    await withServer(app, async (base) => {
      expect((await fetch(`${base}/bad`)).status).toBe(400);
    });
    await client.flush();
    expect(sent).toEqual([]);
  });
});

describe("logsetu-js/hono", () => {
  it("reports thrown errors and exposes c.get('logsetu')", async () => {
    const { client, sent } = recordingClient();
    const app = new Hono<{ Variables: { logsetu: LogSetuClient } }>();
    app.use(logsetu({ client, flush: true }));
    app.get("/ok", (c) => {
      c.get("logsetu").info("inside handler", { a: 1 });
      return c.text("ok");
    });
    app.get("/boom/:id", () => {
      throw new Error("kaboom");
    });

    expect((await app.request("/ok", { headers: { "x-request-id": "req-1" } })).status).toBe(200);
    expect((await app.request("/boom/9")).status).toBe(500);

    expect(sent.map((l) => [l.level, l.message])).toEqual([
      ["info", "inside handler"],
      ["error", "kaboom"],
    ]);
    expect(sent[0]!.meta).toMatchObject({ requestId: "req-1", method: "GET", path: "/ok", a: 1 });
    expect(sent[1]!.meta).toMatchObject({ method: "GET", path: "/boom/9", status: 500, name: "Error" });
  });

  it("logs requests, reports bare 5xx, ignores HTTPException 4xx", async () => {
    const { client, sent } = recordingClient();
    const app = new Hono();
    app.use(logsetu({ client, logRequests: true, flush: true, ignorePaths: [/^\/health/] }));
    app.get("/health", (c) => c.text("ok"));
    app.get("/teapot", () => {
      throw new HTTPException(418, { message: "short and stout" });
    });
    app.get("/down", (c) => c.text("down", 503));
    app.get("/fine", (c) => c.text("fine"));

    await app.request("/health");
    await app.request("/teapot");
    await app.request("/down");
    await app.request("/fine");

    expect(sent.map((l) => [l.level, l.message])).toEqual([
      ["warn", "GET /teapot 418"],
      ["error", "HTTP 503 on GET /down"],
      ["info", "GET /fine 200"],
    ]);
  });

  it("hands the flush to executionCtx.waitUntil on edge runtimes", async () => {
    const { client, sent } = recordingClient();
    const app = new Hono();
    app.use(logsetu({ client }));
    app.get("/boom", () => {
      throw new Error("edge failure");
    });
    const waited: Promise<unknown>[] = [];
    const executionCtx = { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException() {}, props: {} };
    await app.request("/boom", {}, {}, executionCtx);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(sent.map((l) => l.message)).toEqual(["edge failure"]);
  });
});
