"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { ProjectSummary } from "@/lib/types";
import { Logo } from "./Logo";

export function TopBar({ projects }: { projects: ProjectSummary[] }) {
  return (
    <header className="h-12 shrink-0 border-b border-border bg-surface flex items-center px-4 gap-4">
      <Link href="/dashboard" className="shrink-0">
        <Logo />
      </Link>
      <Suspense>
        <ProjectSwitcher projects={projects} />
      </Suspense>
      <nav className="ml-auto flex items-center gap-1 text-sm">
        <NavLink href="/dashboard">Logs</NavLink>
        <NavLink href="/dashboard/issues">Issues</NavLink>
        <NavLink href="/dashboard/projects">Projects</NavLink>
        <a
          href="https://github.com/itsrajverma/logsetu"
          target="_blank"
          rel="noreferrer"
          className="px-2.5 py-1 rounded text-ink-2 hover:text-ink hover:bg-surface-2"
        >
          Docs
        </a>
        <LogoutButton />
      </nav>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Suspense fallback={<NavAnchor href={href}>{children}</NavAnchor>}>
      <NavLinkWithProject href={href}>{children}</NavLinkWithProject>
    </Suspense>
  );
}

// Keep the selected project when moving between Logs / Issues / Projects.
function NavLinkWithProject({ href, children }: { href: string; children: React.ReactNode }) {
  const project = useSearchParams().get("project");
  return <NavAnchor href={project ? `${href}?project=${encodeURIComponent(project)}` : href} match={href}>{children}</NavAnchor>;
}

function NavAnchor({ href, match = href, children }: { href: string; match?: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === match;
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 rounded ${active ? "bg-surface-3 text-ink" : "text-ink-2 hover:text-ink hover:bg-surface-2"}`}
    >
      {children}
    </Link>
  );
}

function ProjectSwitcher({ projects }: { projects: ProjectSummary[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("project") ?? projects[0]?.id ?? "";

  if (projects.length === 0) return null;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-3 hidden sm:inline">Project</span>
      <select
        className="input py-1 pr-7 min-w-40"
        value={current}
        onChange={(e) => {
          const next = new URLSearchParams();
          next.set("project", e.target.value);
          router.push(`${pathname === "/dashboard" ? "/dashboard" : pathname}?${next.toString()}`);
        }}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="px-2.5 py-1 rounded text-ink-2 hover:text-ink hover:bg-surface-2"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
