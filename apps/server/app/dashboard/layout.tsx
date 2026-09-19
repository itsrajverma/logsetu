import { db } from "@/lib/db";
import type { ProjectSummary } from "@/lib/types";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const rows = await db.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, apiKey: true, createdAt: true, _count: { select: { logs: true } } },
  });
  const projects: ProjectSummary[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    apiKey: p.apiKey,
    createdAt: p.createdAt.toISOString(),
    logCount: p._count.logs,
  }));

  return (
    <div className="min-h-full flex flex-col">
      <TopBar projects={projects} />
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
