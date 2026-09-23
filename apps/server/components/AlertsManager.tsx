"use client";

import { useCallback, useEffect, useState } from "react";
import type { AlertEventDTO, AlertRuleDTO } from "@/lib/alert-rules";
import { LOG_LEVELS } from "@/lib/constants";
import { levelColor } from "@/lib/levels";
import { Spinner, formatDateTime, timeAgo } from "./ui";

type AlertsResponse = {
  rules: AlertRuleDTO[];
  events: AlertEventDTO[];
  emailConfigured: boolean;
  publicUrlConfigured: boolean;
};

type Draft = {
  name: string;
  trigger: "threshold" | "new_issue";
  levels: string[];
  source: string;
  environment: string;
  threshold: string;
  windowMinutes: string;
  cooldownMinutes: string;
  channel: "webhook" | "slack" | "email";
  target: string;
};

const EMPTY: Draft = {
  name: "",
  trigger: "threshold",
  levels: ["error", "fatal"],
  source: "",
  environment: "",
  threshold: "10",
  windowMinutes: "5",
  cooldownMinutes: "15",
  channel: "slack",
  target: "",
};

const TARGET_PLACEHOLDER: Record<Draft["channel"], string> = {
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://example.com/hooks/logsetu",
  email: "oncall@example.com, dev@example.com",
};

function toDraft(r: AlertRuleDTO): Draft {
  return {
    name: r.name,
    trigger: r.trigger as Draft["trigger"],
    levels: r.levels,
    source: r.source ?? "",
    environment: r.environment ?? "",
    threshold: String(r.threshold),
    windowMinutes: String(r.windowMinutes),
    cooldownMinutes: String(r.cooldownMinutes),
    channel: r.channel as Draft["channel"],
    target: r.target,
  };
}

function describe(r: AlertRuleDTO): string {
  const scope = [r.source && `source=${r.source}`, r.environment && `env=${r.environment}`].filter(Boolean).join(", ");
  const what =
    r.trigger === "new_issue"
      ? `New or regressed ${r.levels.join("/")} issue`
      : `≥ ${r.threshold} ${r.levels.join("/")} logs in ${r.windowMinutes} min`;
  return `${what}${scope ? ` (${scope})` : ""} → ${r.channel}`;
}

export function AlertsManager({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/alerts?projectId=${projectId}`, { cache: "no-store" });
    if (res.ok) setData((await res.json()) as AlertsResponse);
  }, [projectId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        details?: { path: string; message: string }[];
      };
      if (!res.ok) {
        const detail = json.details?.map((d) => `${d.path}: ${d.message}`).join("\n");
        alert(detail || json.error || `Request failed (${res.status})`);
        return null;
      }
      return json;
    } finally {
      setBusy(false);
      void load();
    }
  }

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  };

  if (!data) {
    return (
      <div className="p-6 text-sm text-ink-3 flex items-center gap-2">
        <Spinner /> Loading…
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">Alerts</h1>
          <p className="text-xs text-ink-3">
            Get notified on Slack, email or any webhook when <span className="mono">{projectName}</span> starts failing.
          </p>
        </div>
        {flash && <span className="text-xs text-ink-2">{flash}</span>}
        <button className="btn btn-primary ml-auto" onClick={() => setEditing("new")} disabled={editing === "new"}>
          New alert
        </button>
      </div>

      {!data.publicUrlConfigured && (
        <p className="text-xs text-ink-3 border border-border rounded-md px-3 py-2 bg-surface">
          Tip: set <code className="mono">LOGSETU_PUBLIC_URL</code> (e.g. https://logs.example.com) so notifications
          include a link back to the dashboard.
        </p>
      )}

      {editing === "new" && (
        <RuleForm
          initial={EMPTY}
          emailConfigured={data.emailConfigured}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={async (body) => {
            if (await call("POST", "/api/v1/alerts", { projectId, ...body })) {
              setEditing(null);
              showFlash("Alert created");
            }
          }}
        />
      )}

      <section className="space-y-2">
        {data.rules.length === 0 && editing !== "new" && (
          <div className="bg-surface border border-border rounded-lg p-6 text-sm text-ink-2 text-center">
            No alerts yet. A good first one: <span className="text-ink">≥ 10 error/fatal logs in 5 minutes → Slack</span>.
          </div>
        )}
        {data.rules.map((r) =>
          editing === r.id ? (
            <RuleForm
              key={r.id}
              initial={toDraft(r)}
              emailConfigured={data.emailConfigured}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSubmit={async (body) => {
                if (await call("PATCH", `/api/v1/alerts/${r.id}`, body)) {
                  setEditing(null);
                  showFlash("Saved");
                }
              }}
            />
          ) : (
            <div key={r.id} className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center gap-3">
              <label className="flex items-center" title={r.enabled ? "Enabled" : "Disabled"}>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  disabled={busy}
                  onChange={(e) => void call("PATCH", `/api/v1/alerts/${r.id}`, { enabled: e.target.checked })}
                  aria-label={`Enable ${r.name}`}
                />
              </label>
              <div className={`min-w-0 flex-1 ${r.enabled ? "" : "opacity-50"}`}>
                <div className="text-sm font-medium truncate">{r.name}</div>
                <div className="text-xs text-ink-3 truncate">
                  {describe(r)}
                  {r.lastTriggeredAt && ` · last fired ${timeAgo(r.lastTriggeredAt)}`}
                </div>
              </div>
              <button
                className="btn py-1 px-2 text-xs"
                disabled={busy}
                onClick={async () => {
                  const res = (await call("POST", `/api/v1/alerts/${r.id}/test`)) as { ok?: boolean } | null;
                  if (res?.ok) showFlash(`Test sent via ${r.channel}`);
                }}
              >
                Send test
              </button>
              <button className="btn py-1 px-2 text-xs" onClick={() => setEditing(r.id)} disabled={busy}>
                Edit
              </button>
              <button
                className="btn btn-danger py-1 px-2 text-xs"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Delete alert "${r.name}"?`)) void call("DELETE", `/api/v1/alerts/${r.id}`);
                }}
              >
                Delete
              </button>
            </div>
          ),
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">Recent notifications</h2>
        {data.events.length === 0 ? (
          <p className="text-xs text-ink-3">Nothing sent yet.</p>
        ) : (
          <div className="bg-surface border border-border rounded-lg divide-y divide-border">
            {data.events.map((e) => (
              <div key={e.id} className="px-4 py-2 text-xs flex items-center gap-3">
                <span
                  className="badge"
                  style={{
                    color: e.success ? levelColor("info") : levelColor("error"),
                    border: `1px solid ${e.success ? levelColor("info") : levelColor("error")}55`,
                  }}
                >
                  {e.success ? (e.test ? "test" : "sent") : "failed"}
                </span>
                <span className="text-ink truncate flex-1" title={e.error ?? e.message}>
                  {e.message}
                  {e.error && <span className="text-level-error"> — {e.error}</span>}
                </span>
                <span className="text-ink-3 shrink-0" title={formatDateTime(e.createdAt)}>
                  {timeAgo(e.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RuleForm({
  initial,
  emailConfigured,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: Draft;
  emailConfigured: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [d, setD] = useState<Draft>(initial);
  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <form
      className="bg-surface border border-accent/50 rounded-lg p-4 space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({
          name: d.name,
          trigger: d.trigger,
          levels: d.levels,
          source: d.source || null,
          environment: d.environment || null,
          threshold: Number(d.threshold),
          windowMinutes: Number(d.windowMinutes),
          cooldownMinutes: Number(d.cooldownMinutes),
          channel: d.channel,
          target: d.target,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Name">
          <input className="input w-full" required value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Error spike" />
        </Labeled>
        <Labeled label="Trigger">
          <select className="input w-full" value={d.trigger} onChange={(e) => set({ trigger: e.target.value as Draft["trigger"] })}>
            <option value="threshold">Log count exceeds a threshold</option>
            <option value="new_issue">New issue or regression</option>
          </select>
        </Labeled>
      </div>

      <Labeled label="Levels">
        <div className="flex gap-1">
          {LOG_LEVELS.map((lvl) => {
            const on = d.levels.includes(lvl);
            const disabled = d.trigger === "new_issue" && lvl !== "error" && lvl !== "fatal";
            const color = levelColor(lvl);
            return (
              <button
                key={lvl}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                className="badge cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: on ? "#fff" : color, background: on ? color : `${color}14`, border: `1px solid ${on ? color : `${color}55`}` }}
                onClick={() => set({ levels: on ? d.levels.filter((l) => l !== lvl) : [...d.levels, lvl] })}
              >
                {lvl}
              </button>
            );
          })}
        </div>
      </Labeled>

      <div className="grid gap-3 sm:grid-cols-5">
        {d.trigger === "threshold" && (
          <>
            <Labeled label="At least">
              <input className="input w-full mono" inputMode="numeric" value={d.threshold} onChange={(e) => set({ threshold: e.target.value })} />
            </Labeled>
            <Labeled label="Within (min)">
              <input className="input w-full mono" inputMode="numeric" value={d.windowMinutes} onChange={(e) => set({ windowMinutes: e.target.value })} />
            </Labeled>
          </>
        )}
        <Labeled label="Cooldown (min)">
          <input className="input w-full mono" inputMode="numeric" value={d.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: e.target.value })} />
        </Labeled>
        <Labeled label="Source (optional)">
          <input className="input w-full" value={d.source} onChange={(e) => set({ source: e.target.value })} placeholder="any" />
        </Labeled>
        {d.trigger === "threshold" && (
          <Labeled label="Environment (optional)">
            <input className="input w-full" value={d.environment} onChange={(e) => set({ environment: e.target.value })} placeholder="any" />
          </Labeled>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Labeled label="Notify via">
          <select className="input w-full" value={d.channel} onChange={(e) => set({ channel: e.target.value as Draft["channel"] })}>
            <option value="slack">Slack</option>
            <option value="webhook">Webhook</option>
            <option value="email">Email</option>
          </select>
        </Labeled>
        <Labeled label={d.channel === "email" ? "Recipients" : d.channel === "slack" ? "Slack incoming webhook URL" : "Webhook URL (receives JSON POST)"}>
          <input className="input w-full mono text-[13px]" required value={d.target} onChange={(e) => set({ target: e.target.value })} placeholder={TARGET_PLACEHOLDER[d.channel]} />
        </Labeled>
      </div>
      {d.channel === "email" && !emailConfigured && (
        <p className="text-xs text-level-warn">
          Email isn&apos;t configured on this server — set <code className="mono">LOGSETU_SMTP_URL</code> and{" "}
          <code className="mono">LOGSETU_SMTP_FROM</code>.
        </p>
      )}

      <div className="flex gap-2 justify-end">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || d.levels.length === 0}>
          Save
        </button>
      </div>
    </form>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] uppercase tracking-wide text-ink-3">{label}</span>
      {children}
    </label>
  );
}
