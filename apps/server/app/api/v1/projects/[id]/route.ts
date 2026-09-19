import { db } from "@/lib/db";
import { error, json, zodError } from "@/lib/api";
import { generateApiKey, invalidateApiKeyCache, isAdminRequest } from "@/lib/auth";
import { createProjectSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project) return error(404, "Project not found");
  return json({ project });
}

// Rename, or rotate the API key with { rotateKey: true }
export async function PATCH(req: Request, { params }: Ctx) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: string; rotateKey?: boolean };
  const existing = await db.project.findUnique({ where: { id } });
  if (!existing) return error(404, "Project not found");

  const data: { name?: string; apiKey?: string } = {};
  if (body.name !== undefined) {
    const parsed = createProjectSchema.safeParse({ name: body.name });
    if (!parsed.success) return zodError(parsed.error);
    data.name = parsed.data.name;
  }
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
