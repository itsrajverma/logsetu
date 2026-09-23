import { db } from "@/lib/db";
import { error, json, zodError } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { invalidateAlertRules } from "@/lib/alerts";
import { toRuleData, toRuleDTO } from "@/lib/alert-rules";
import { alertRulePatchSchema, alertRuleSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const existing = await db.alertRule.findUnique({ where: { id } });
  if (!existing) return error(404, "Alert rule not found");

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = alertRulePatchSchema.safeParse(raw);
  if (!parsed.success) return zodError(parsed.error);
  // Only keys the client actually sent (transforms/defaults must not touch omitted fields).
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k in raw));

  // Re-validate the merged rule so e.g. switching channel to "email" requires an email target.
  const merged = alertRuleSchema.safeParse({
    ...existing,
    levels: existing.levels.split(",").filter(Boolean),
    ...patch,
  });
  if (!merged.success) return zodError(merged.error);

  const rule = await db.alertRule.update({ where: { id }, data: toRuleData(patch) });
  invalidateAlertRules(rule.projectId);
  return json({ rule: toRuleDTO(rule) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const rule = await db.alertRule.findUnique({ where: { id }, select: { projectId: true } });
  if (!rule) return error(404, "Alert rule not found");
  await db.alertRule.delete({ where: { id } });
  invalidateAlertRules(rule.projectId);
  return json({ deleted: true });
}
