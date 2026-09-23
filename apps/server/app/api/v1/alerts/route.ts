import { db } from "@/lib/db";
import { error, json, zodError } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { invalidateAlertRules } from "@/lib/alerts";
import { toRuleData, toRuleDTO, type AlertEventDTO } from "@/lib/alert-rules";
import { isEmailConfigured, publicUrl } from "@/lib/notify";
import { createAlertRuleSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Alert rules + recent alert history for a project (admin). */
export async function GET(req: Request) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return error(400, "projectId is required");

  const [rules, events] = await Promise.all([
    db.alertRule.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    db.alertEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { rule: { select: { name: true } } },
    }),
  ]);
  return json({
    rules: rules.map(toRuleDTO),
    events: events.map(
      (e): AlertEventDTO => ({
        id: e.id,
        ruleId: e.ruleId,
        ruleName: e.rule.name,
        message: e.message,
        count: e.count,
        success: e.success,
        error: e.error,
        test: e.test,
        createdAt: e.createdAt.toISOString(),
      }),
    ),
    emailConfigured: isEmailConfigured(),
    publicUrlConfigured: publicUrl() !== null,
  });
}

export async function POST(req: Request) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const parsed = createAlertRuleSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return zodError(parsed.error);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId }, select: { id: true } });
  if (!project) return error(404, "Project not found");

  const rule = await db.alertRule.create({ data: toRuleData(parsed.data) });
  invalidateAlertRules(rule.projectId);
  return json({ rule: toRuleDTO(rule) }, { status: 201 });
}
