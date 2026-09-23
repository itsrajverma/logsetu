import { db } from "./db";
import { subscribeIssues, subscribeLogs } from "./events";
import type { IssueChange } from "./grouping";
import type { LogRecord } from "./logs";
import { deliver, publicUrl, type Notification } from "./notify";

// Alert engine. Driven by the in-process event bus: new logs schedule a (throttled) threshold check for the
// rules they could affect; new/regressed issues fire "new_issue" rules directly. Cooldowns are claimed with a
// conditional UPDATE so concurrent evaluations can't double-send.

export const ALERT_TRIGGERS = ["threshold", "new_issue"] as const;
export type AlertTrigger = (typeof ALERT_TRIGGERS)[number];

export type AlertRuleRow = {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: string;
  levels: string;
  source: string | null;
  environment: string | null;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  channel: string;
  target: string;
  lastTriggeredAt: Date | null;
};

const RULE_CACHE_TTL = 30_000;
const MIN_EVAL_SPACING_MS = 10_000;
const EVAL_DELAY_MS = 1_000; // let a burst of batches land before counting

type State = {
  ruleCache: Map<string, { rules: AlertRuleRow[]; expires: number }>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  lastEval: Map<string, number>;
  unsubscribe?: () => void;
};
const g = globalThis as { __logsetuAlerts?: State };
const state: State = (g.__logsetuAlerts ??= { ruleCache: new Map(), timers: new Map(), lastEval: new Map() });

export function ruleLevels(rule: Pick<AlertRuleRow, "levels">): string[] {
  return rule.levels.split(",").map((l) => l.trim()).filter(Boolean);
}

export function invalidateAlertRules(projectId?: string) {
  if (projectId) state.ruleCache.delete(projectId);
  else state.ruleCache.clear();
}

async function rulesFor(projectId: string): Promise<AlertRuleRow[]> {
  const cached = state.ruleCache.get(projectId);
  if (cached && cached.expires > Date.now()) return cached.rules;
  const rules = await db.alertRule.findMany({ where: { projectId, enabled: true } });
  state.ruleCache.set(projectId, { rules, expires: Date.now() + RULE_CACHE_TTL });
  return rules;
}

export function logMatchesRule(log: Pick<LogRecord, "level" | "source" | "environment">, rule: AlertRuleRow): boolean {
  if (!ruleLevels(rule).includes(log.level)) return false;
  if (rule.source && log.source !== rule.source) return false;
  if (rule.environment && log.environment !== rule.environment) return false;
  return true;
}

function dashboardLink(path: string): string | null {
  const base = publicUrl();
  return base ? `${base}${path}` : null;
}

/** Atomically take the cooldown slot; false if the rule fired too recently. */
async function claimCooldown(rule: AlertRuleRow, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - rule.cooldownMinutes * 60_000);
  const { count } = await db.alertRule.updateMany({
    where: {
      id: rule.id,
      enabled: true,
      ...(rule.cooldownMinutes > 0 ? { OR: [{ lastTriggeredAt: null }, { lastTriggeredAt: { lte: since } }] } : {}),
    },
    data: { lastTriggeredAt: now },
  });
  return count === 1;
}

async function send(rule: AlertRuleRow, n: Notification, count: number, test = false): Promise<{ ok: boolean; error?: string }> {
  let error: string | undefined;
  try {
    await deliver(rule.channel, rule.target, n);
  } catch (e) {
    error = (e as Error).message || String(e);
    console.error(`[logsetu] alert "${rule.name}" delivery failed: ${error}`);
  }
  await db.alertEvent.create({
    data: { ruleId: rule.id, projectId: rule.projectId, message: n.title, count, success: !error, error, test },
  });
  return error ? { ok: false, error } : { ok: true };
}

async function projectName(projectId: string): Promise<string> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } });
  return p?.name ?? projectId;
}

/** Count matching logs in the rule's window and fire if the threshold is reached. */
export async function evaluateThreshold(rule: AlertRuleRow, now = new Date()): Promise<"fired" | "below" | "cooldown"> {
  const levels = ruleLevels(rule);
  const since = new Date(now.getTime() - rule.windowMinutes * 60_000);
  const where = {
    projectId: rule.projectId,
    level: { in: levels },
    timestamp: { gte: since },
    ...(rule.source ? { source: rule.source } : {}),
    ...(rule.environment ? { environment: rule.environment } : {}),
  };
  const count = await db.logEntry.count({ where });
  if (count < rule.threshold) return "below";
  if (!(await claimCooldown(rule, now))) return "cooldown";

  const samples = await db.logEntry.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: 5,
    select: { level: true, message: true, source: true, timestamp: true },
  });
  const name = await projectName(rule.projectId);
  const q = new URLSearchParams({ project: rule.projectId, level: levels.join(",") });
  if (rule.source) q.set("source", rule.source);
  if (rule.environment) q.set("environment", rule.environment);
  const filters = [rule.source && `source=${rule.source}`, rule.environment && `env=${rule.environment}`].filter(Boolean);
  const scope = `${levels.join("/")} logs${filters.length ? ` (${filters.join(", ")})` : ""}`;
  const text =
    `${count} ${scope} in the last ${rule.windowMinutes} min — threshold is ${rule.threshold}.\n` +
    samples.map((s) => `• [${s.level}] ${s.source}: ${s.message.split("\n")[0]!.slice(0, 200)}`).join("\n");

  await send(
    rule,
    {
      title: `[LogSetu] ${name}: ${rule.name}`,
      text,
      url: dashboardLink(`/dashboard?${q.toString()}&range=1h`),
      payload: {
        event: "threshold",
        rule: { id: rule.id, name: rule.name, levels, threshold: rule.threshold, windowMinutes: rule.windowMinutes },
        project: { id: rule.projectId, name },
        count,
        samples,
      },
    },
    count,
  );
  return "fired";
}

/** Fire new_issue rules for newly created or regressed issues. */
export async function handleIssueChanges(projectId: string, changes: IssueChange[], now = new Date()) {
  const interesting = changes.filter((c) => c.kind !== "existing");
  if (interesting.length === 0) return;
  const rules = (await rulesFor(projectId)).filter((r) => r.trigger === "new_issue");
  if (rules.length === 0) return;
  const name = await projectName(projectId);

  for (const rule of rules) {
    const matching = interesting.filter(
      (c) => ruleLevels(rule).includes(c.issue.level) && (!rule.source || c.issue.source === rule.source),
    );
    if (matching.length === 0 || !(await claimCooldown(rule, now))) continue;
    const first = matching[0]!;
    const label = first.kind === "regression" ? "Regression" : "New issue";
    const more = matching.length > 1 ? ` (+${matching.length - 1} more)` : "";
    await send(
      rule,
      {
        title: `[LogSetu] ${name}: ${label} — ${first.issue.title.slice(0, 120)}${more}`,
        text: matching
          .map(
            (c) =>
              `• ${c.kind === "regression" ? "Regression" : "New"} [${c.issue.level}] ${c.issue.source}: ${c.issue.title}` +
              (c.issue.culprit ? ` — ${c.issue.culprit}` : ""),
          )
          .join("\n"),
        url: dashboardLink(`/dashboard?project=${projectId}&issue=${first.issue.id}&range=all`),
        payload: {
          event: "new_issue",
          rule: { id: rule.id, name: rule.name },
          project: { id: projectId, name },
          issues: matching.map((c) => ({ kind: c.kind, ...c.issue })),
        },
      },
      matching.length,
    );
  }
}

export async function sendTestAlert(rule: AlertRuleRow) {
  const name = await projectName(rule.projectId);
  return send(
    rule,
    {
      title: `[LogSetu] ${name}: test notification for "${rule.name}"`,
      text: "If you can read this, alert delivery works.",
      url: dashboardLink(`/dashboard/alerts?project=${rule.projectId}`),
      payload: { event: "test", rule: { id: rule.id, name: rule.name }, project: { id: rule.projectId, name } },
    },
    0,
    true,
  );
}

function scheduleThresholdCheck(rule: AlertRuleRow) {
  if (state.timers.has(rule.id)) return;
  const last = state.lastEval.get(rule.id) ?? 0;
  const delay = Math.max(EVAL_DELAY_MS, last + MIN_EVAL_SPACING_MS - Date.now());
  const t = setTimeout(async () => {
    state.timers.delete(rule.id);
    state.lastEval.set(rule.id, Date.now());
    try {
      // Re-read so edits/disables made since the cache was filled are honoured.
      const fresh = await db.alertRule.findUnique({ where: { id: rule.id } });
      if (fresh?.enabled && fresh.trigger === "threshold") await evaluateThreshold(fresh);
    } catch (e) {
      console.error("[logsetu] alert evaluation failed", e);
    }
  }, delay);
  t.unref?.();
  state.timers.set(rule.id, t);
}

async function handleLogs(logs: LogRecord[]) {
  const byProject = new Map<string, LogRecord[]>();
  for (const l of logs) byProject.set(l.projectId, [...(byProject.get(l.projectId) ?? []), l]);
  for (const [projectId, batch] of byProject) {
    const rules = (await rulesFor(projectId)).filter((r) => r.trigger === "threshold");
    for (const rule of rules) if (batch.some((l) => logMatchesRule(l, rule))) scheduleThresholdCheck(rule);
  }
}

/** Start listening for new logs/issues (called once from instrumentation.ts). */
export function startAlertEngine() {
  if (state.unsubscribe) return;
  const offLogs = subscribeLogs("*", (logs) => {
    handleLogs(logs).catch((e) => console.error("[logsetu] alert scheduling failed", e));
  });
  const offIssues = subscribeIssues((projectId, changes) => {
    handleIssueChanges(projectId, changes).catch((e) => console.error("[logsetu] issue alert failed", e));
  });
  state.unsubscribe = () => {
    offLogs();
    offIssues();
  };
}
