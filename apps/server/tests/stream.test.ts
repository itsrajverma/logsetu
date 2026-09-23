import { describe, expect, it, vi } from "vitest";
import { listenerCount, publishLogs, subscribeLogs } from "@/lib/events";
import { matchesQuery, type LogRecord } from "@/lib/logs";

const log = (over: Partial<LogRecord> = {}): LogRecord => ({
  id: "l1",
  projectId: "p1",
  level: "error",
  message: "Payment FAILED for order 42",
  source: "api",
  environment: "production",
  meta: null,
  timestamp: new Date("2026-09-20T10:00:00Z"),
  createdAt: new Date("2026-09-20T10:00:00Z"),
  ...over,
});

describe("matchesQuery", () => {
  it("mirrors the database filters in memory", () => {
    const q = { projectId: "p1" };
    expect(matchesQuery(log(), q)).toBe(true);
    expect(matchesQuery(log({ projectId: "p2" }), q)).toBe(false);
    expect(matchesQuery(log(), { ...q, level: ["warn", "error"] })).toBe(true);
    expect(matchesQuery(log(), { ...q, level: ["info"] })).toBe(false);
    expect(matchesQuery(log(), { ...q, source: "worker" })).toBe(false);
    expect(matchesQuery(log(), { ...q, environment: "production" })).toBe(true);
    expect(matchesQuery(log(), { ...q, search: "payment failed" })).toBe(true);
    expect(matchesQuery(log(), { ...q, search: "refund" })).toBe(false);
    expect(matchesQuery(log(), { ...q, from: new Date("2026-09-20T11:00:00Z") })).toBe(false);
    expect(matchesQuery(log(), { ...q, to: new Date("2026-09-20T11:00:00Z") })).toBe(true);
  });
});

describe("log event bus", () => {
  it("delivers to project and wildcard subscribers and unsubscribes cleanly", () => {
    const perProject = vi.fn();
    const other = vi.fn();
    const all = vi.fn();
    const offs = [subscribeLogs("p1", perProject), subscribeLogs("p2", other), subscribeLogs("*", all)];

    publishLogs("p1", [log()]);
    publishLogs("p1", []); // empty batches are dropped

    expect(perProject).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(1);

    offs.forEach((off) => off());
    expect(listenerCount("p1")).toBe(0);
    expect(listenerCount("*")).toBe(0);
  });
});
