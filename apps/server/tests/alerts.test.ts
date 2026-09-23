import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";

const dbFile = path.join(__dirname, "alerts-test.db");
// Set before anything imports lib/db (app modules are imported lazily below).
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.LOGSETU_PUBLIC_URL = "https://logs.example.com/";

// A local webhook receiver that records every POST body.
const received: { path: string; body: Record<string, unknown> }[] = [];
let failNext = false;
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (failNext) {
      failNext = false;
      res.writeHead(500).end("nope");
      return;
    }
    received.push({ path: req.url ?? "", body: JSON.parse(data) as Record<string, unknown> });
    res.writeHead(200).end("ok");
  });
});
let hook = "";

beforeAll(async () => {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
  execFileSync("node", [path.join(__dirname, "..", "scripts", "migrate.mjs")], { env: process.env, stdio: "ignore" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  const { db } = await import("@/lib/db");
  await db.$disconnect();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
});

const ago = (min: number) => new Date(Date.now() - min * 60_000);

describe("threshold alerts", () => {
  it("fires once the threshold is reached, then respects the cooldown", async () => {
    const { db } = await import("@/lib/db");
    const { evaluateThreshold } = await import("@/lib/alerts");
    const p = await db.project.create({ data: { name: "shop", apiKey: "k-threshold" } });
    const rule = await db.alertRule.create({
      data: {
        projectId: p.id,
        name: "Error spike",
        levels: "error,fatal",
        source: "api",
        threshold: 3,
        windowMinutes: 5,
        cooldownMinutes: 15,
        channel: "webhook",
        target: `${hook}/threshold`,
      },
    });
    await db.logEntry.createMany({
      data: [
        { projectId: p.id, level: "error", message: "db down", source: "api", timestamp: ago(1) },
        { projectId: p.id, level: "error", message: "db down", source: "api", timestamp: ago(2) },
        { projectId: p.id, level: "error", message: "too old", source: "api", timestamp: ago(10) },
        { projectId: p.id, level: "error", message: "other source", source: "web", timestamp: ago(1) },
        { projectId: p.id, level: "warn", message: "not a matching level", source: "api", timestamp: ago(1) },
      ],
    });

    expect(await evaluateThreshold(rule)).toBe("below");

    await db.logEntry.create({ data: { projectId: p.id, level: "fatal", message: "db down hard", source: "api" } });
    expect(await evaluateThreshold(rule)).toBe("fired");
    const hit = received.find((r) => r.path === "/threshold")!;
    expect(hit.body).toMatchObject({ event: "threshold", count: 3, project: { name: "shop" } });
    expect(hit.body.title).toBe("[LogSetu] shop: Error spike");
    expect(String(hit.body.url)).toMatch(/^https:\/\/logs\.example\.com\/dashboard\?project=/);

    // Within the cooldown: no second notification even though the threshold is still exceeded.
    const fresh = await db.alertRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect(await evaluateThreshold(fresh)).toBe("cooldown");
    // After the cooldown it can fire again.
    expect(await evaluateThreshold(fresh, new Date(Date.now() + 16 * 60_000))).toBe("below"); // window moved on too
    const events = await db.alertEvent.findMany({ where: { ruleId: rule.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(true);
  });

  it("records failed deliveries", async () => {
    const { db } = await import("@/lib/db");
    const { sendTestAlert } = await import("@/lib/alerts");
    const p = await db.project.create({ data: { name: "failing", apiKey: "k-fail" } });
    const rule = await db.alertRule.create({
      data: { projectId: p.id, name: "x", channel: "webhook", target: `${hook}/fail` },
    });
    failNext = true;
    const r = await sendTestAlert(rule);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 500/);
    const ev = await db.alertEvent.findFirstOrThrow({ where: { ruleId: rule.id } });
    expect(ev).toMatchObject({ success: false, test: true });
  });
});

describe("new issue alerts", () => {
  it("fires for new and regressed issues only, in Slack format", async () => {
    const { db } = await import("@/lib/db");
    const { handleIssueChanges, invalidateAlertRules } = await import("@/lib/alerts");
    const { assignIssues } = await import("@/lib/grouping");
    const p = await db.project.create({ data: { name: "web", apiKey: "k-issue" } });
    await db.alertRule.create({
      data: {
        projectId: p.id,
        name: "New errors",
        trigger: "new_issue",
        cooldownMinutes: 0,
        channel: "slack",
        target: `${hook}/slack`,
      },
    });
    invalidateAlertRules(p.id);

    const first = await assignIssues(p.id, [{ level: "error", message: "Checkout crashed", source: "web" }]);
    await handleIssueChanges(p.id, first);
    const again = await assignIssues(p.id, [{ level: "error", message: "Checkout crashed", source: "web" }]);
    await handleIssueChanges(p.id, again); // existing issue → no alert
    await db.issue.updateMany({ where: { projectId: p.id }, data: { status: "resolved" } });
    const regressed = await assignIssues(p.id, [{ level: "error", message: "Checkout crashed", source: "web" }]);
    await handleIssueChanges(p.id, regressed);

    const slack = received.filter((r) => r.path === "/slack");
    expect(slack.map((s) => s.body.text)).toEqual([
      "[LogSetu] web: New issue — Checkout crashed",
      "[LogSetu] web: Regression — Checkout crashed",
    ]);
    expect(JSON.stringify(slack[0]!.body.blocks)).toContain("Open in LogSetu");
  });
});

describe("rule validation", () => {
  it("checks targets per channel and keeps omitted fields on PATCH", async () => {
    const { createAlertRuleSchema, alertRulePatchSchema } = await import("@/lib/validation");
    const base = { projectId: "p", name: "n" };
    expect(createAlertRuleSchema.safeParse({ ...base, channel: "slack", target: "not a url" }).success).toBe(false);
    expect(createAlertRuleSchema.safeParse({ ...base, channel: "email", target: "a@b.co, bad" }).success).toBe(false);
    const ok = createAlertRuleSchema.parse({ ...base, channel: "email", target: "a@b.co, c@d.io" });
    expect(ok).toMatchObject({ threshold: 10, windowMinutes: 5, cooldownMinutes: 15, levels: ["error", "fatal"] });
    expect(alertRulePatchSchema.parse({ enabled: false })).not.toHaveProperty("threshold");
  });
});
