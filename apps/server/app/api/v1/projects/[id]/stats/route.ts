import { db } from "@/lib/db";
import { error, json } from "@/lib/api";
import { authorizeRead } from "@/lib/auth";
import { getProjectStats } from "@/lib/logs";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeRead(req);
  if (!auth.ok) return error(401, "Unauthorized");
  const { id } = await params;
  if (auth.restrictToProject && auth.restrictToProject !== id) return error(403, "Forbidden");
  const project = await db.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) return error(404, "Project not found");
  return json(await getProjectStats(id));
}
