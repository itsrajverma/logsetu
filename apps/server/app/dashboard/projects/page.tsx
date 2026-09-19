import { db } from "@/lib/db";
import type { ProjectSummary } from "@/lib/types";
import { ProjectsManager } from "@/components/ProjectsManager";
import { getDefaultRetentionDays } from "@/lib/retention";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const rows = await db.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, apiKey: true, retentionDays: true, createdAt: true, _count: { select: { logs: true } } },
  });
  const projects: ProjectSummary[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    apiKey: p.apiKey,
    retentionDays: p.retentionDays,
    createdAt: p.createdAt.toISOString(),
    logCount: p._count.logs,
  }));
  const selected = typeof sp.project === "string" ? sp.project : undefined;

  return (
    <ProjectsManager
      projects={projects}
      initialSelected={selected}
      justCreated={sp.created === "1"}
      defaultRetentionDays={getDefaultRetentionDays()}
    />
  );
}
