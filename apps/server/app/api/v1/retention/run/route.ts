import { error, json } from "@/lib/api";
import { isAdminRequest } from "@/lib/auth";
import { getLastRetentionResult, runRetentionCleanup } from "@/lib/retention";

export const dynamic = "force-dynamic";

/** Trigger a retention cleanup now (admin). Optional body: { projectId } */
export async function POST(req: Request) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const body = (await req.json().catch(() => ({}))) as { projectId?: string };
  return json(await runRetentionCleanup(body.projectId));
}

export async function GET() {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  return json({ last: getLastRetentionResult() });
}
