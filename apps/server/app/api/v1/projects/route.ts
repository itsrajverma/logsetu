import { db } from "@/lib/db";
import { error, json, zodError } from "@/lib/api";
import { generateApiKey, isAdminRequest } from "@/lib/auth";
import { createProjectSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const projects = await db.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, apiKey: true, createdAt: true, _count: { select: { logs: true } } },
  });
  return json({
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      apiKey: p.apiKey,
      createdAt: p.createdAt,
      logCount: p._count.logs,
    })),
  });
}

export async function POST(req: Request) {
  if (!(await isAdminRequest())) return error(401, "Unauthorized");
  const body = await req.json().catch(() => null);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);
  const project = await db.project.create({ data: { name: parsed.data.name, apiKey: generateApiKey() } });
  return json({ project }, { status: 201 });
}
