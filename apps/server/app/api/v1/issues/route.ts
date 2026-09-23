import { error, json, searchParamsToObject, zodError } from "@/lib/api";
import { authorizeRead } from "@/lib/auth";
import { queryIssues } from "@/lib/issues";
import { issuesQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Grouped errors for a project. Admin session or that project's API key. */
export async function GET(req: Request) {
  const auth = await authorizeRead(req);
  if (!auth.ok) return error(401, "Unauthorized");

  const raw = searchParamsToObject(new URL(req.url).searchParams);
  if (auth.restrictToProject) raw.projectId = auth.restrictToProject;
  const parsed = issuesQuerySchema.safeParse(raw);
  if (!parsed.success) return zodError(parsed.error);

  return json(await queryIssues(parsed.data));
}
