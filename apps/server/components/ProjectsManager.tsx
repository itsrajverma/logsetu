"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/types";
import { CopyButton, formatDateTime } from "./ui";

export function ProjectsManager({
  projects,
  initialSelected,
  justCreated,
}: {
  projects: ProjectSummary[];
  initialSelected?: string;
  justCreated?: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialSelected ?? projects[0]?.id ?? null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null;

  useEffect(() => {
    if (justCreated && initialSelected) setRevealed((r) => ({ ...r, [initialSelected]: true }));
  }, [justCreated, initialSelected]);

  async function call(method: string, path: string, body?: unknown) {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        alert(data.error ?? `Request failed (${res.status})`);
        return null;
      }
      return (await res.json()) as unknown;
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const data = (await call("POST", "/api/v1/projects", { name: newName.trim() })) as { project: { id: string } } | null;
    if (data) {
      setNewName("");
      setSelectedId(data.project.id);
      setRevealed((r) => ({ ...r, [data.project.id]: true }));
    }
  }

  async function rename(p: ProjectSummary) {
    const name = prompt("Project name", p.name);
    if (name && name.trim() && name.trim() !== p.name) await call("PATCH", `/api/v1/projects/${p.id}`, { name: name.trim() });
  }

  async function rotate(p: ProjectSummary) {
    if (confirm(`Rotate the API key for "${p.name}"? Existing SDK configs will stop working until updated.`)) {
      await call("PATCH", `/api/v1/projects/${p.id}`, { rotateKey: true });
      setRevealed((r) => ({ ...r, [p.id]: true }));
    }
  }

  async function remove(p: ProjectSummary) {
    if (confirm(`Delete "${p.name}" and all ${p.logCount.toLocaleString()} of its logs? This cannot be undone.`)) {
      await call("DELETE", `/api/v1/projects/${p.id}`);
      if (selectedId === p.id) setSelectedId(null);
    }
  }

  const [origin, setOrigin] = useState("http://localhost:8686");
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <main className="h-[calc(100vh-3rem)] overflow-auto">
      <div className="max-w-6xl mx-auto p-6 grid gap-6 lg:grid-cols-[360px_1fr]">
        <section className="space-y-3">
          <h1 className="text-lg font-semibold">Projects</h1>
          <form onSubmit={create} className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="New project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || !newName.trim()}>
              Create
            </button>
          </form>
          <ul className="space-y-1">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full text-left rounded-md border px-3 py-2 ${
                    selected?.id === p.id ? "border-accent bg-surface-2" : "border-border bg-surface hover:bg-surface-2"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{p.name}</span>
                    <span className="mono text-xs text-ink-3">{p.logCount.toLocaleString()} logs</span>
                  </div>
                  <div className="text-xs text-ink-3 mt-0.5" suppressHydrationWarning>
                    Created {formatDateTime(p.createdAt)}
                  </div>
                </button>
              </li>
            ))}
            {projects.length === 0 && <li className="text-sm text-ink-3">No projects yet.</li>}
          </ul>
        </section>

        {selected && (
          <section className="space-y-5">
            <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold">{selected.name}</h2>
                <span className="mono text-xs text-ink-3">{selected.id}</span>
                <div className="ml-auto flex gap-1">
                  <a className="btn py-1 text-xs" href={`/dashboard?project=${selected.id}`}>
                    View logs
                  </a>
                  <button className="btn py-1 text-xs" onClick={() => rename(selected)} disabled={busy}>
                    Rename
                  </button>
                  <button className="btn py-1 text-xs" onClick={() => rotate(selected)} disabled={busy}>
                    Rotate key
                  </button>
                  <button className="btn btn-danger py-1 text-xs" onClick={() => remove(selected)} disabled={busy}>
                    Delete
                  </button>
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">API key</div>
                <div className="flex items-center gap-2">
                  <code className="mono text-sm bg-bg border border-border rounded px-2.5 py-1.5 flex-1 truncate">
                    {revealed[selected.id] ? selected.apiKey : "•".repeat(36)}
                  </code>
                  <button
                    className="btn py-1.5 text-xs"
                    onClick={() => setRevealed((r) => ({ ...r, [selected.id]: !r[selected.id] }))}
                  >
                    {revealed[selected.id] ? "Hide" : "Reveal"}
                  </button>
                  <CopyButton text={selected.apiKey} label="Copy" className="py-1.5" />
                </div>
              </div>
            </div>

            <Snippets apiKey={selected.apiKey} origin={origin} />
          </section>
        )}
      </div>
    </main>
  );
}

function Snippets({ apiKey, origin }: { apiKey: string; origin: string }) {
  const [tab, setTab] = useState<"js" | "django" | "curl">("js");
  const snippets: Record<typeof tab, { title: string; code: string }> = {
    js: {
      title: "Next.js / React (logsetu-js)",
      code: `npm install logsetu-js

import { LogSetu } from "logsetu-js";

const logger = LogSetu.init({
  apiKey: "${apiKey}",
  endpoint: "${origin}",
  environment: "production",
  source: "nextjs-web",
});

logger.info("User logged in", { userId: 123 });
logger.error("Payment failed", { orderId: 456 });`,
    },
    django: {
      title: "Django (logsetu-django)",
      code: `pip install logsetu-django

# settings.py
LOGGING = {
    "version": 1,
    "handlers": {
        "logsetu": {
            "class": "logsetu.handler.LogSetuHandler",
            "api_key": "${apiKey}",
            "endpoint": "${origin}",
            "environment": "production",
            "source": "django-backend",
            "level": "WARNING",
        },
    },
    "root": {"handlers": ["logsetu"], "level": "INFO"},
}

MIDDLEWARE = [..., "logsetu.middleware.LogSetuMiddleware"]`,
    },
    curl: {
      title: "HTTP API (any language)",
      code: `curl -X POST ${origin}/api/v1/ingest \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"level":"info","message":"hello","source":"shell","meta":{"k":"v"}}'`,
    },
  };

  return (
    <div className="bg-surface border border-border rounded-lg">
      <div className="flex items-center border-b border-border px-2">
        {(Object.keys(snippets) as (typeof tab)[]).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === k ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {snippets[k].title}
          </button>
        ))}
        <div className="ml-auto pr-1">
          <CopyButton text={snippets[tab].code} label="Copy" />
        </div>
      </div>
      <pre className="mono text-xs leading-relaxed p-4 overflow-x-auto text-ink-2">{snippets[tab].code}</pre>
    </div>
  );
}
