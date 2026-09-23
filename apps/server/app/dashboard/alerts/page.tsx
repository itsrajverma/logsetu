import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AlertsManager } from "@/components/AlertsManager";
import { Onboarding } from "@/components/Onboarding";

export const dynamic = "force-dynamic";

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const requested = typeof sp.project === "string" ? sp.project : undefined;

  const projects = await db.project.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (projects.length === 0) return <Onboarding />;

  const project = projects.find((p) => p.id === requested) ?? projects[0]!;
  if (requested !== project.id) redirect(`/dashboard/alerts?project=${project.id}`);

  return <AlertsManager key={project.id} projectId={project.id} projectName={project.name} />;
}
