"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function Onboarding() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Could not create project");
      return;
    }
    const { project } = (await res.json()) as { project: { id: string } };
    router.push(`/dashboard/projects?project=${project.id}&created=1`);
    router.refresh();
  }

  return (
    <main className="h-full flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-surface border border-border rounded-lg p-6">
        <h1 className="text-lg font-semibold">Create your first project</h1>
        <p className="text-sm text-ink-2 mt-1 mb-5">
          A project groups logs from one app (or one stack). You will get an API key to paste into the SDKs.
        </p>
        <form onSubmit={create} className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="e.g. my-saas-web"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            Create
          </button>
        </form>
        {error && <p className="text-sm text-level-error mt-2">{error}</p>}
      </div>
    </main>
  );
}
