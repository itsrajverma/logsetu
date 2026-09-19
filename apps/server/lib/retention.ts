import { db } from "./db";

export const MAX_RETENTION_DAYS = 3650;

/** Global fallback for projects without their own setting. Unset/0 = keep forever. */
export function getDefaultRetentionDays(): number | null {
  const n = Number(process.env.LOGSETU_DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_RETENTION_DAYS) : null;
}

export function effectiveRetentionDays(projectRetentionDays: number | null): number | null {
  return projectRetentionDays ?? getDefaultRetentionDays();
}

export type RetentionResult = {
  ranAt: string;
  projects: { id: string; name: string; retentionDays: number; deleted: number }[];
  totalDeleted: number;
};

let lastResult: RetentionResult | null = null;
let running: Promise<RetentionResult> | null = null;

export function getLastRetentionResult(): RetentionResult | null {
  return lastResult;
}

/** Delete logs older than each project's retention window. Safe to call concurrently (runs are serialized). */
export function runRetentionCleanup(projectId?: string): Promise<RetentionResult> {
  if (running) return running;
  running = (async () => {
    const projects = await db.project.findMany({
      where: projectId ? { id: projectId } : undefined,
      select: { id: true, name: true, retentionDays: true },
    });
    const result: RetentionResult = { ranAt: new Date().toISOString(), projects: [], totalDeleted: 0 };
    for (const p of projects) {
      const days = effectiveRetentionDays(p.retentionDays);
      if (!days) continue;
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const { count } = await db.logEntry.deleteMany({ where: { projectId: p.id, timestamp: { lt: cutoff } } });
      result.projects.push({ id: p.id, name: p.name, retentionDays: days, deleted: count });
      result.totalDeleted += count;
    }
    if (result.totalDeleted > 0) console.log(`[logsetu] retention: deleted ${result.totalDeleted} logs`);
    lastResult = result;
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

const g = globalThis as { __logsetuRetentionTimer?: ReturnType<typeof setInterval> };

/** Start the periodic cleanup (called once from instrumentation.ts). */
export function startRetentionScheduler() {
  if (g.__logsetuRetentionTimer) return;
  const minutes = Number(process.env.LOGSETU_RETENTION_INTERVAL_MINUTES);
  const intervalMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
  const tick = () => runRetentionCleanup().catch((e) => console.error("[logsetu] retention cleanup failed", e));
  // First pass shortly after boot, then on the interval.
  const first = setTimeout(tick, 60_000);
  first.unref?.();
  g.__logsetuRetentionTimer = setInterval(tick, intervalMs);
  g.__logsetuRetentionTimer.unref?.();
}
