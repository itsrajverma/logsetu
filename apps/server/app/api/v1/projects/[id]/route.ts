import { db } from "@/lib/db";
import { error, json, zodError } from "@/lib/api";
import { generateApiKey, invalidateApiKeyCache, isAdminRequest } from "@/lib/auth";
import { updateProjectSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) return error(404, "Project not found");
  return json({ project });
}

// Rename, set retention, or rotate the API key with { rotateKey: true }
export async function PATCH(req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const parsed = updateProjectSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return zodError(parsed.error);
  const body = parsed.data;
  const existing = await db.project.findUnique({ where: { id } });
  if (!existing) return error(404, "Project not found");

  const data: { name?: string; apiKey?: string; retentionDays?: number | null } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.retentionDays !== undefined) data.retentionDays = body.retentionDays;
  if (body.rotateKey) data.apiKey = generateApiKey();

  const project = await db.project.update({ where: { id }, data });
  if (data.apiKey) invalidateApiKeyCache(existing.apiKey);
  return json({ project });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const existing = await db.project.findUnique({ where: { id } });
  if (!existing) return error(404, "Project not found");
  await db.project.delete({ where: { id } });
  invalidateApiKeyCache(existing.apiKey);
  return json({ ok: true });
}
