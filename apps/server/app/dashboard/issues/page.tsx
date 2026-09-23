import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { IssuesList } from "@/components/IssuesList";
import { Onboarding } from "@/components/Onboarding";

export const dynamic = "force-dynamic";

export default async function IssuesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const requested = typeof sp.project === "string" ? sp.project : undefined;

  const projects = await db.project.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (projects.length === 0) return <Onboarding />;

  const project = projects.find((p) => p.id === requested) ?? projects[0]!;
  if (requested !== project.id) redirect(`/dashboard/issues?project=${project.id}`);

  return <IssuesList key={project.id} projectId={project.id} projectName={project.name} />;
}
