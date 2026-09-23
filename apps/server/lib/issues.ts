import { db, isPostgres } from "./db";
import type { IssuesQuery } from "./validation";
import type { IssueDTO, IssuesResponse } from "./types";
import type { Prisma } from "@/generated/sqlite/client";

type IssueRow = {
  id: string;
  projectId: string;
  title: string;
  culprit: string | null;
  level: string;
  source: string;
  status: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  resolvedAt: Date | null;
};

export function toIssueDTO(i: IssueRow, last24h = 0): IssueDTO {
  return {
    id: i.id,
    projectId: i.projectId,
    title: i.title,
    culprit: i.culprit,
    level: i.level,
    source: i.source,
    status: i.status as IssueDTO["status"],
    count: i.count,
    last24h,
    firstSeen: i.firstSeen.toISOString(),
    lastSeen: i.lastSeen.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
  };
}

/** Events per issue in the last 24h, for the given issue ids. */
export async function recentEventCounts(issueIds: string[]): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await db.logEntry.groupBy({
    by: ["issueId"],
    where: { issueId: { in: issueIds }, timestamp: { gte: since } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.issueId as string, r._count._all]));
}

export async function queryIssues(q: IssuesQuery): Promise<IssuesResponse> {
  const where: Prisma.IssueWhereInput = { projectId: q.projectId };
  if (q.status !== "all") where.status = q.status;
  if (q.search) {
    where.title = isPostgres()
      ? ({ contains: q.search, mode: "insensitive" } as unknown as Prisma.StringFilter)
      : { contains: q.search };
  }
  const orderBy: Prisma.IssueOrderByWithRelationInput[] =
    q.sort === "count" ? [{ count: "desc" }, { lastSeen: "desc" }] : [{ [q.sort]: "desc" }, { id: "desc" }];

  const [rows, total, byStatus] = await Promise.all([
    db.issue.findMany({ where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
    db.issue.count({ where }),
    db.issue.groupBy({ by: ["status"], where: { projectId: q.projectId }, _count: { _all: true } }),
  ]);
  const recent = await recentEventCounts(rows.map((r) => r.id));
  const counts = { open: 0, resolved: 0, ignored: 0 };
  for (const s of byStatus) if (s.status in counts) counts[s.status as keyof typeof counts] = s._count._all;

  return {
    issues: rows.map((r) => toIssueDTO(r, recent.get(r.id) ?? 0)),
    total,
    page: q.page,
    limit: q.limit,
    hasMore: q.page * q.limit < total,
    counts,
  };
}
