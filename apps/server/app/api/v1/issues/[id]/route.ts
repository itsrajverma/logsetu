import { db } from "@/lib/db";
import { error, json, zodError } from "@/lib/api";
import { authorizeRead, isAdminRequest } from "@/lib/auth";
import { recentEventCounts, toIssueDTO } from "@/lib/issues";
import { updateIssueSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const auth = await authorizeRead(req);
  if (!auth.ok) return error(401, "Unauthorized");
  const { id } = await params;
  const issue = await db.issue.findUnique({ where: { id } });
  if (!issue || (auth.restrictToProject && auth.restrictToProject !== issue.projectId)) {
    return error(404, "Issue not found");
  }
  const recent = await recentEventCounts([id]);
  return json({ issue: toIssueDTO(issue, recent.get(id) ?? 0) });
}

/** Resolve, ignore or reopen an issue (admin). */
export async function PATCH(req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const parsed = updateIssueSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return zodError(parsed.error);
  const existing = await db.issue.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return error(404, "Issue not found");

  const { status } = parsed.data;
  const issue = await db.issue.update({
    where: { id },
    data: { status, resolvedAt: status === "resolved" ? new Date() : null },
  });
  return json({ issue: toIssueDTO(issue) });
}

/** Delete an issue; its events stay in the log table, ungrouped (admin). */
export async function DELETE(_req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const { count } = await db.issue.deleteMany({ where: { id } });
  if (count === 0) return error(404, "Issue not found");
  return json({ deleted: true });
}
