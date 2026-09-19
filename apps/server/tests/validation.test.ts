import { describe, expect, it } from "vitest";
import { logsQuerySchema, parseIngestBody } from "@/lib/validation";

describe("parseIngestBody", () => {
  it("accepts a single log and normalizes level", () => {
    const r = parseIngestBody({ level: "ERROR", message: "boom" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toHaveLength(1);
      expect(r.data[0]!.level).toBe("error");
      expect(r.data[0]!.timestamp).toBeInstanceOf(Date);
    }
  });

  it("accepts an array and a wrapped { logs } body", () => {
    expect(parseIngestBody([{ message: "a" }, { message: "b" }])).toMatchObject({ success: true });
    const r = parseIngestBody({ logs: [{ message: "a" }] });
    expect(r.success && r.data.length).toBe(1);
  });

  it("parses unix seconds, unix millis and ISO timestamps", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const cases = [1767323045, 1767323045000, iso];
    for (const ts of cases) {
      const r = parseIngestBody({ message: "x", timestamp: ts });
      expect(r.success && r.data[0]!.timestamp.toISOString()).toBe(iso);
    }
  });

  it("rejects unknown levels, empty messages and oversized batches", () => {
    expect(parseIngestBody({ level: "loud", message: "x" }).success).toBe(false);
    expect(parseIngestBody({ message: "" }).success).toBe(false);
    expect(parseIngestBody(Array.from({ length: 501 }, () => ({ message: "x" }))).success).toBe(false);
    expect(parseIngestBody("nope").success).toBe(false);
  });
});

describe("logsQuerySchema", () => {
  it("parses comma separated levels and coerces paging", () => {
    const r = logsQuerySchema.safeParse({ projectId: "p", level: "error,WARN", page: "2", limit: "10" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.level).toEqual(["error", "warn"]);
      expect(r.data.page).toBe(2);
      expect(r.data.limit).toBe(10);
    }
  });

  it("caps limit and rejects bad dates", () => {
    expect(logsQuerySchema.safeParse({ projectId: "p", limit: "9999" }).success).toBe(false);
    expect(logsQuerySchema.safeParse({ projectId: "p", from: "yesterday" }).success).toBe(false);
  });
});
