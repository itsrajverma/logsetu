"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LogDTO, LogsResponse, StatsResponse } from "@/lib/types";
import { LOG_LEVELS } from "@/lib/constants";
import { LEVEL_ORDER, levelColor } from "@/lib/levels";
import { filtersToQuery, RANGE_PRESETS, useFilters, type RangePreset } from "./useFilters";
import { LogTable } from "./LogTable";
import { LogDetail } from "./LogDetail";
import { StatsBar } from "./StatsBar";
import { Spinner } from "./ui";

const PAGE_SIZE = 100;
const POLL_MS = 3000;
const STATS_POLL_MS = 30_000;

export function LogExplorer({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { filters, update } = useFilters(projectId);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<LogDTO | null>(null);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const abortRef = useRef<AbortController | null>(null);

  const fetchLogs = useCallback(
    async (background: boolean) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      if (!background) setLoading(true);
      try {
        const q = filtersToQuery(projectId, filters, PAGE_SIZE);
        const res = await fetch(`/api/v1/logs?${q.toString()}`, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as LogsResponse);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [projectId, filters],
  );

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/stats`, { cache: "no-store" });
      if (res.ok) setStats((await res.json()) as StatsResponse);
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void fetchLogs(false);
  }, [fetchLogs]);

  useEffect(() => {
    void fetchStats();
    const t = setInterval(fetchStats, STATS_POLL_MS);
    return () => clearInterval(t);
  }, [fetchStats]);

  // Live updates: Server-Sent Events push, falling back to polling if the stream can't be kept open.
  const [transport, setTransport] = useState<"sse" | "poll">("sse");
  useEffect(() => {
    if (!live || filters.page !== 1) return;
    if (transport === "poll" || typeof EventSource === "undefined") {
      const t = setInterval(() => void fetchLogs(true), POLL_MS);
      return () => clearInterval(t);
    }
    const q = filtersToQuery(projectId, filters, PAGE_SIZE);
    q.delete("page");
    q.delete("limit");
    // Relative ranges ("last 24h") always include brand-new logs; don't pin the lower bound at connect time.
    if (filters.range !== "custom") q.delete("from");
    const es = new EventSource(`/api/v1/logs/stream?${q.toString()}`);
    let failures = 0;
    let opened = false;
    es.addEventListener("ready", () => {
      failures = 0;
      // Catch up on anything ingested while (re)connecting.
      if (opened) void fetchLogs(true);
      opened = true;
    });
    es.addEventListener("logs", (ev) => {
      const incoming = JSON.parse((ev as MessageEvent<string>).data) as LogDTO[];
      setData((prev) => mergeLive(prev, incoming));
    });
    es.onerror = () => {
      failures += 1;
      if (es.readyState === EventSource.CLOSED || failures >= 3) {
        es.close();
        setTransport("poll");
      }
    };
    return () => es.close();
  }, [live, transport, projectId, filters, fetchLogs]);

  useEffect(() => setSearchDraft(filters.search), [filters.search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleLevel = (lvl: string) => {
    const set = new Set(filters.level);
    if (set.has(lvl)) set.delete(lvl);
    else set.add(lvl);
    update({ level: LEVEL_ORDER.filter((l) => set.has(l)) });
  };

  const hasFilters =
    filters.level.length > 0 || filters.source || filters.environment || filters.search || filters.range !== "24h";

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      <StatsBar stats={stats} activeLevels={filters.level} onToggleLevel={toggleLevel} />

      {/* Filters */}
      <div className="border-b border-border bg-surface px-4 py-2 flex flex-wrap items-center gap-2">
        <form
          className="flex-1 min-w-56"
          onSubmit={(e) => {
            e.preventDefault();
            update({ search: searchDraft.trim() });
          }}
        >
          <input
            className="input w-full mono text-[13px]"
            placeholder={`Search ${projectName} logs…  (Enter)`}
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onBlur={() => {
              if (searchDraft.trim() !== filters.search) update({ search: searchDraft.trim() });
            }}
          />
        </form>

        <div className="flex items-center gap-1" role="group" aria-label="Level filter">
          {LOG_LEVELS.map((lvl) => {
            const on = filters.level.includes(lvl);
            const color = levelColor(lvl);
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                className="badge cursor-pointer transition-colors"
                style={{
                  color: on ? "#fff" : color,
                  background: on ? color : `${color}14`,
                  border: `1px solid ${on ? color : `${color}55`}`,
                }}
                aria-pressed={on}
              >
                {lvl}
              </button>
            );
          })}
        </div>

        <select className="input py-1" value={filters.source} onChange={(e) => update({ source: e.target.value })}>
          <option value="">All sources</option>
          {(stats?.sources ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          className="input py-1"
          value={filters.environment}
          onChange={(e) => update({ environment: e.target.value })}
        >
          <option value="">All envs</option>
          {(stats?.environments ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          className="input py-1"
          value={filters.range}
          onChange={(e) => update({ range: e.target.value as RangePreset | "all" | "custom" })}
        >
          {Object.keys(RANGE_PRESETS).map((k) => (
            <option key={k} value={k}>
              Last {k}
            </option>
          ))}
          <option value="all">All time</option>
          <option value="custom">Custom…</option>
        </select>

        {filters.range === "custom" && (
          <div className="flex items-center gap-1">
            <input
              type="datetime-local"
              className="input py-1 text-xs"
              value={filters.from}
              onChange={(e) => update({ from: e.target.value })}
            />
            <span className="text-ink-3 text-xs">→</span>
            <input
              type="datetime-local"
              className="input py-1 text-xs"
              value={filters.to}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        )}

        {hasFilters && (
          <button
            className="btn py-1 text-xs"
            onClick={() =>
              update({ level: [], source: "", environment: "", search: "", range: "24h", from: "", to: "" })
            }
          >
            Clear
          </button>
        )}

        <button
          type="button"
          className={`btn py-1 text-xs ${live ? "border-level-info/60" : ""}`}
          onClick={() => setLive((v) => !v)}
          title={
            live
              ? `Pause live updates (${transport === "sse" ? "streaming" : "polling every 3s"})`
              : "Resume live updates"
          }
        >
          <span
            className={`h-2 w-2 rounded-full ${live ? "bg-level-info live-dot" : "bg-ink-3"}`}
            aria-hidden
          />
          {live ? "Live" : "Paused"}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-auto">
            {error ? (
              <div className="p-6 text-sm text-level-error">Failed to load logs: {error}</div>
            ) : loading && !data ? (
              <div className="p-6 text-sm text-ink-3 flex items-center gap-2">
                <Spinner /> Loading…
              </div>
            ) : data && data.logs.length === 0 ? (
              <EmptyState hasFilters={Boolean(hasFilters)} projectId={projectId} />
            ) : data ? (
              <LogTable logs={data.logs} selectedId={selected?.id ?? null} onSelect={setSelected} />
            ) : null}
          </div>
          <Footer
            data={data}
            page={filters.page}
            loading={loading}
            onPage={(p) => update({ page: p })}
          />
        </div>
        {selected && (
          <LogDetail
            log={selected}
            onClose={() => setSelected(null)}
            onFilter={(patch) => update(patch)}
          />
        )}
      </div>
    </div>
  );
}

/** Prepend streamed logs to the first page, newest first, keeping page size and total in sync. */
function mergeLive(prev: LogsResponse | null, incoming: LogDTO[]): LogsResponse | null {
  if (!prev) return prev;
  const seen = new Set(prev.logs.map((l) => l.id));
  const fresh = incoming.filter((l) => !seen.has(l.id));
  if (fresh.length === 0) return prev;
  const logs = [...fresh, ...prev.logs]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, prev.limit);
  const total = prev.total + fresh.length;
  return { ...prev, logs, total, hasMore: prev.page * prev.limit < total };
}

function Footer({
  data,
  page,
  loading,
  onPage,
}: {
  data: LogsResponse | null;
  page: number;
  loading: boolean;
  onPage: (p: number) => void;
}) {
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="h-9 shrink-0 border-t border-border bg-surface px-4 flex items-center gap-3 text-xs text-ink-2">
      <span className="mono">
        {total.toLocaleString()} {total === 1 ? "log" : "logs"}
      </span>
      {loading && <Spinner />}
      <div className="ml-auto flex items-center gap-1">
        <button className="btn py-0.5 px-2 text-xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹ Prev
        </button>
        <span className="mono px-2">
          {page} / {pages}
        </span>
        <button className="btn py-0.5 px-2 text-xs" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next ›
        </button>
      </div>
    </div>
  );
}

function EmptyState({ hasFilters, projectId }: { hasFilters: boolean; projectId: string }) {
  return (
    <div className="p-10 text-center text-sm text-ink-2">
      {hasFilters ? (
        <p>No logs match these filters.</p>
      ) : (
        <div className="max-w-md mx-auto space-y-3">
          <p className="text-ink">No logs yet. Send your first one:</p>
          <pre className="text-left text-xs bg-surface-2 border border-border rounded-md p-3 overflow-x-auto mono">
{`curl -X POST ${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/ingest \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"level":"info","message":"hello from curl","source":"shell"}'`}
          </pre>
          <p>
            Grab the API key from the{" "}
            <a className="text-accent hover:underline" href={`/dashboard/projects?project=${projectId}`}>
              Projects
            </a>{" "}
            page.
          </p>
        </div>
      )}
    </div>
  );
}
