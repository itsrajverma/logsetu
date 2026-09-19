import { error, json, searchParamsToObject, zodError } from "@/lib/api";
import { authorizeRead } from "@/lib/auth";
import { queryLogs } from "@/lib/logs";
import { logsQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authorizeRead(req);
  if (!auth.ok) return error(401, "Unauthorized");

  const raw = searchParamsToObject(new URL(req.url).searchParams);
  if (auth.restrictToProject) raw.projectId = auth.restrictToProject;
  const parsed = logsQuerySchema.safeParse(raw);
  if (!parsed.success) return zodError(parsed.error);

  return json(await queryLogs(parsed.data));
}
