import { db } from "@/lib/db";
import { error, json } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { sendTestAlert } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/** Send a test notification through the rule's channel (ignores cooldown and enabled state). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const rule = await db.alertRule.findUnique({ where: { id } });
  if (!rule) return error(404, "Alert rule not found");
  const result = await sendTestAlert(rule);
  return json(result, { status: result.ok ? 200 : 502 });
}
