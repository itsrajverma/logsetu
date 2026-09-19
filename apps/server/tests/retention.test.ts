import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dbFile = path.join(__dirname, "retention-test.db");
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.LOGSETU_DEFAULT_RETENTION_DAYS = "30";

beforeAll(() => {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  execFileSync("node", [path.join(__dirname, "..", "scripts", "migrate.mjs")], { env: process.env, stdio: "ignore" });
});

afterAll(async () => {
  const { db } = await import("@/lib/db");
  await db.$disconnect();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
});

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("retention cleanup", () => {
  it("deletes only logs past each project's effective window", async () => {
    const { db } = await import("@/lib/db");
    const { runRetentionCleanup, effectiveRetentionDays } = await import("@/lib/retention");

    const custom = await db.project.create({ data: { name: "custom", apiKey: "k1", retentionDays: 7 } });
    const dflt = await db.project.create({ data: { name: "default", apiKey: "k2" } });
    await db.logEntry.createMany({
      data: [
        { projectId: custom.id, level: "info", message: "old", timestamp: days(8) },
        { projectId: custom.id, level: "info", message: "fresh", timestamp: days(6) },
        { projectId: dflt.id, level: "info", message: "old", timestamp: days(31) },
        { projectId: dflt.id, level: "info", message: "fresh", timestamp: days(29) },
      ],
    });

    expect(effectiveRetentionDays(7)).toBe(7);
    expect(effectiveRetentionDays(null)).toBe(30);

    const result = await runRetentionCleanup();
    expect(result.totalDeleted).toBe(2);
    expect(result.projects.map((p) => [p.name, p.retentionDays, p.deleted])).toEqual([
      ["custom", 7, 1],
      ["default", 30, 1],
    ]);
    const remaining = await db.logEntry.findMany({ select: { message: true } });
    expect(remaining.every((l) => l.message === "fresh")).toBe(true);

    // Second run is a no-op; project filter is honoured
    expect((await runRetentionCleanup(custom.id)).projects).toHaveLength(1);
    expect((await runRetentionCleanup()).totalDeleted).toBe(0);
  });
});
