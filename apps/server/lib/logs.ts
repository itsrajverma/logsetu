import { db, isPostgres } from "./db";
import type { LogsQuery } from "./validation";
import type { Prisma } from "@/generated/sqlite/client";
import { LOG_LEVELS, type LogLevel } from "./constants";

export type LogRecord = {
  id: string;
  projectId: string;
  level: string;
  message: string;
  source: string;
  environment: string;
  meta: unknown;
  timestamp: Date;
  createdAt: Date;
  issueId: string | null;
};

export function buildWhere(q: LogsQuery): Prisma.LogEntryWhereInput {
  const where: Prisma.LogEntryWhereInput = { projectId: q.projectId };
  if (q.level && q.level.length > 0) where.level = q.level.length === 1 ? q.level[0] : { in: q.level };
  if (q.source) where.source = q.source;
  if (q.environment) where.environment = q.environment;
  if (q.issueId) where.issueId = q.issueId;
  if (q.from || q.to) {
    where.timestamp = {};
    if (q.from) where.timestamp.gte = q.from;
    if (q.to) where.timestamp.lte = q.to;
  }
  if (q.search) {
    // Postgres needs mode: "insensitive"; SQLite LIKE is already case-insensitive for ASCII.
    where.message = isPostgres()
      ? ({ contains: q.search, mode: "insensitive" } as unknown as Prisma.StringFilter)
      : { contains: q.search };
  }
  return where;
}

/** In-memory equivalent of buildWhere(), used to filter live-streamed logs. */
export function matchesQuery(
  log: LogRecord,
  q: Pick<LogsQuery, "projectId"> & Partial<Omit<LogsQuery, "projectId" | "page" | "limit">>,
): boolean {
  if (log.projectId !== q.projectId) return false;
  if (q.level && q.level.length > 0 && !(q.level as string[]).includes(log.level)) return false;
  if (q.source && log.source !== q.source) return false;
  if (q.environment && log.environment !== q.environment) return false;
  if (q.issueId && log.issueId !== q.issueId) return false;
  if (q.from && log.timestamp < q.from) return false;
  if (q.to && log.timestamp > q.to) return false;
  if (q.search && !log.message.toLowerCase().includes(q.search.toLowerCase())) return false;
  return true;
}

export type LogsPage = { logs: LogRecord[]; total: number; page: number; limit: number; hasMore: boolean };

export async function queryLogs(q: LogsQuery): Promise<LogsPage> {
  const where = buildWhere(q);
  const [logs, total] = await Promise.all([
    db.logEntry.findMany({
      where,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    db.logEntry.count({ where }),
  ]);
  return { logs, total, page: q.page, limit: q.limit, hasMore: q.page * q.limit < total };
}

export type ProjectStats = {
  total: number;
  last24h: Record<LogLevel, number>;
  series: { bucket: string; counts: Record<LogLevel, number> }[];
  sources: string[];
  environments: string[];
};

function emptyCounts(): Record<LogLevel, number> {
  return { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
}

function isLevel(s: string): s is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(s);
}

export async function getProjectStats(projectId: string): Promise<ProjectStats> {
  const HOUR = 3_600_000;
  const start = new Date(Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR);

  const [total, byLevel, sourceRows, envRows, buckets] = await Promise.all([
    db.logEntry.count({ where: { projectId } }),
    db.logEntry.groupBy({
      by: ["level"],
      where: { projectId, timestamp: { gte: start } },
      _count: { _all: true },
    }),
    db.logEntry.findMany({ where: { projectId }, distinct: ["source"], select: { source: true }, take: 100 }),
    db.logEntry.findMany({ where: { projectId }, distinct: ["environment"], select: { environment: true }, take: 100 }),
    Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const from = new Date(start.getTime() + i * HOUR);
        const to = new Date(from.getTime() + HOUR);
        return db.logEntry
          .groupBy({
            by: ["level"],
            where: { projectId, timestamp: { gte: from, lt: to } },
            _count: { _all: true },
          })
          .then((rows) => ({ bucket: from.toISOString(), rows }));
      }),
    ),
  ]);

  const last24h = emptyCounts();
  for (const row of byLevel) if (isLevel(row.level)) last24h[row.level] = row._count._all;

  const series = buckets.map((b) => {
    const counts = emptyCounts();
    for (const row of b.rows) if (isLevel(row.level)) counts[row.level] = row._count._all;
    return { bucket: b.bucket, counts };
  });

  return {
    total,
    last24h,
    series,
    sources: sourceRows.map((r) => r.source).sort(),
    environments: envRows.map((r) => r.environment).sort(),
  };
}
