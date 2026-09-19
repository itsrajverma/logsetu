import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogSetuClient, LogSetu } from "../src/index";
import type { LogEntry } from "../src/types";

type Call = { url: string; init: RequestInit; body: LogEntry[] };

function mockFetch(responder: (call: Call, n: number) => Response | Promise<Response> = () => new Response(null, { status: 202 })) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) as LogEntry[] };
    calls.push(call);
    return responder(call, calls.length);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const base = { apiKey: "ls_test", endpoint: "http://logsetu.local/" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LogSetuClient", () => {
  it("batches logs and flushes on the interval", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({ ...base, fetch: fetchImpl, source: "test", environment: "ci" });
    c.info("one", { a: 1 });
    c.warn("two");
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://logsetu.local/api/v1/ingest");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer ls_test");
    expect(calls[0]!.body.map((l) => [l.level, l.message])).toEqual([["info", "one"], ["warn", "two"]]);
    expect(calls[0]!.body[0]).toMatchObject({ source: "test", environment: "ci", meta: { a: 1 } });
    expect(new Date(calls[0]!.body[0]!.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("flushes immediately when the batch size is reached", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({ ...base, fetch: fetchImpl, batchSize: 3 });
    c.info("1");
    c.info("2");
    c.info("3");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toHaveLength(3);
  });

  it("retries with backoff on 5xx and network errors, then gives up", async () => {
    let n = 0;
    const { calls, fetchImpl } = mockFetch(() => {
      n++;
      if (n === 1) throw new Error("ECONNREFUSED");
      if (n === 2) return new Response(null, { status: 503 });
      return new Response(null, { status: 202 });
    });
    const c = new LogSetuClient({ ...base, fetch: fetchImpl });
    c.error("boom");
    const p = c.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(calls).toHaveLength(3);
    expect(calls.every((x) => x.body[0]!.message === "boom")).toBe(true);
  });

  it("drops the batch on a 4xx without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls, fetchImpl } = mockFetch(() => new Response(null, { status: 401 }));
    const c = new LogSetuClient({ ...base, fetch: fetchImpl });
    c.info("x");
    const p = c.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(0);
    warn.mockRestore();
  });

  it("captureException extracts name, message and stack", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({ ...base, fetch: fetchImpl });
    const err = new TypeError("bad thing");
    (err as Error & { code?: string }).code = "E_BAD";
    c.captureException(err, { orderId: 7 });
    c.captureException("plain string");
    await c.flush();
    const [a, b] = calls[0]!.body;
    expect(a).toMatchObject({ level: "error", message: "bad thing", meta: { name: "TypeError", code: "E_BAD", orderId: 7 } });
    expect(String(a!.meta!.stack)).toContain("bad thing");
    expect(b).toMatchObject({ level: "error", message: "plain string", meta: { value: "plain string" } });
  });

  it("flattens { error } meta and serializes circular/bigint values", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({ ...base, fetch: fetchImpl });
    const circular: Record<string, unknown> = { id: 1n };
    circular.self = circular;
    c.error("Payment failed", { error: new Error("declined"), circular, when: new Date(0) });
    await c.flush();
    const meta = calls[0]!.body[0]!.meta!;
    expect(meta.stack).toContain("declined");
    expect(meta.errorName).toBe("Error");
    expect(meta.circular).toEqual({ id: "1", self: "[Circular]" });
    expect(meta.when).toBe("1970-01-01T00:00:00.000Z");
  });

  it("respects minimum level, defaultMeta, setContext, child and beforeSend", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({
      ...base,
      fetch: fetchImpl,
      level: "info",
      defaultMeta: { app: "web" },
      beforeSend: (e) => (e.message.includes("secret") ? null : { ...e, meta: { ...e.meta, scrubbed: true } }),
    });
    c.debug("hidden");
    c.info("visible");
    c.info("has secret");
    c.setContext({ user: 42 });
    c.child({ tenant: "acme" }, { source: "worker" }).warn("from child");
    c.info("after child");
    await c.flush();
    const body = calls[0]!.body;
    expect(body.map((l) => l.message)).toEqual(["visible", "from child", "after child"]);
    expect(body[0]!.meta).toEqual({ app: "web", scrubbed: true });
    expect(body[1]).toMatchObject({ source: "worker", meta: { app: "web", user: 42, tenant: "acme" } });
    expect(body[2]!.meta).toEqual({ app: "web", user: 42, scrubbed: true });
  });

  it("caps the queue at maxQueueSize, dropping the oldest", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({ ...base, fetch: fetchImpl, maxQueueSize: 5, batchSize: 100 });
    for (let i = 0; i < 8; i++) c.info(`m${i}`);
    await c.flush();
    expect(calls[0]!.body.map((l) => l.message)).toEqual(["m3", "m4", "m5", "m6", "m7"]);
  });

  it("is a no-op when disabled", async () => {
    const { calls, fetchImpl } = mockFetch();
    const c = new LogSetuClient({ ...base, fetch: fetchImpl, enabled: false });
    c.fatal("nope");
    await c.flush();
    expect(calls).toHaveLength(0);
  });
});

describe("LogSetu singleton", () => {
  it("init sets the default used by the static helpers", async () => {
    const { calls, fetchImpl } = mockFetch();
    LogSetu.init({ ...base, fetch: fetchImpl });
    LogSetu.info("hello");
    await LogSetu.flush();
    expect(calls[0]!.body[0]!.message).toBe("hello");
    expect(LogSetu.get()).toBeInstanceOf(LogSetuClient);
  });
});
