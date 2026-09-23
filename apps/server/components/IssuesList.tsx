"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IssueDTO, IssuesResponse } from "@/lib/types";
import { levelColor } from "@/lib/levels";
import { LevelBadge, Spinner, formatDateTime, timeAgo } from "./ui";

type Status = "open" | "resolved" | "ignored";
type Sort = "lastSeen" | "firstSeen" | "count";

const POLL_MS = 15_000;
const STATUS_LABEL: Record<Status, string> = { open: "Open", resolved: "Resolved", ignored: "Ignored" };

export function IssuesList({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [status, setStatus] = useState<Status>("open");
  const [sort, setSort] = useState<Sort>("lastSeen");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<IssuesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ projectId, status, sort, page: String(page), limit: "50" });
    if (search) q.set("search", search);
    try {
      const res = await fetch(`/api/v1/issues?${q.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as IssuesResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, status, sort, page, search]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const setIssueStatus = async (issue: IssueDTO, next: Status) => {
    setBusyId(issue.id);
    try {
      await fetch(`/api/v1/issues/${issue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      <div className="border-b border-border bg-surface px-4 py-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="tablist" aria-label="Issue status">
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={status === s}
              className={`btn py-1 text-xs ${status === s ? "bg-surface-3 text-ink" : ""}`}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
            >
              {STATUS_LABEL[s]}
              <span className="mono text-ink-3">{data?.counts[s] ?? "–"}</span>
            </button>
          ))}
        </div>
        <form
          className="flex-1 min-w-56"
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget).get("q");
            setSearch(typeof v === "string" ? v.trim() : "");
            setPage(1);
          }}
        >
          <input name="q" className="input w-full mono text-[13px]" placeholder={`Search ${projectName} issues…  (Enter)`} />
        </form>
        <label className="flex items-center gap-2 text-xs text-ink-2">
          Sort
          <select className="input py-1" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="lastSeen">Last seen</option>
            <option value="firstSeen">First seen</option>
            <option value="count">Events</option>
          </select>
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="p-6 text-sm text-level-error">Failed to load issues: {error}</div>
        ) : !data ? (
          <div className="p-6 text-sm text-ink-3 flex items-center gap-2">
            <Spinner /> Loading…
          </div>
        ) : data.issues.length === 0 ? (
          <div className="p-10 text-center text-sm text-ink-2 max-w-md mx-auto space-y-2">
            <p className="text-ink">{status === "open" ? "No open issues 🎉" : `No ${status} issues.`}</p>
            <p className="text-ink-3">
              Every <code className="mono">error</code> and <code className="mono">fatal</code> log is grouped into an
              issue by its stack trace (or normalized message), so repeated failures show up here once, with a count.
            </p>
          </div>
        ) : (
          <table className="w-full text-[13px] border-collapse">
            <thead className="sticky top-0 z-10 bg-surface text-ink-3 text-[11px] uppercase tracking-wide">
              <tr className="border-b border-border">
                <th className="text-left font-medium px-4 py-1.5">Issue</th>
                <th className="text-right font-medium px-2 py-1.5 w-20">24h</th>
                <th className="text-right font-medium px-2 py-1.5 w-20">Events</th>
                <th className="text-left font-medium px-2 py-1.5 w-28 hidden md:table-cell">Last seen</th>
                <th className="text-left font-medium px-2 py-1.5 w-28 hidden lg:table-cell">First seen</th>
                <th className="w-44" />
              </tr>
            </thead>
            <tbody>
              {data.issues.map((issue) => (
                <tr
                  key={issue.id}
                  className="border-b border-border/60 hover:bg-surface-2 align-top"
                  style={{ boxShadow: `inset 3px 0 0 ${levelColor(issue.level)}` }}
                >
                  <td className="px-4 py-2 max-w-0">
                    <Link
                      href={`/dashboard?project=${projectId}&issue=${issue.id}&range=all`}
                      className="block group"
                      title="Show all events for this issue"
                    >
                      <div className="flex items-center gap-2">
                        <LevelBadge level={issue.level} />
                        <span className="mono text-ink truncate group-hover:underline">{issue.title}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-ink-3 truncate">
                        <span className="text-ink-2">{issue.source}</span>
                        {issue.culprit && <span className="mono"> · {issue.culprit}</span>}
                      </div>
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-right mono text-ink-2">{issue.last24h.toLocaleString()}</td>
                  <td className="px-2 py-2 text-right mono text-ink">{issue.count.toLocaleString()}</td>
                  <td className="px-2 py-2 text-ink-2 hidden md:table-cell" title={formatDateTime(issue.lastSeen)}>
                    {timeAgo(issue.lastSeen)}
                  </td>
                  <td className="px-2 py-2 text-ink-2 hidden lg:table-cell" title={formatDateTime(issue.firstSeen)}>
                    {timeAgo(issue.firstSeen)}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {issue.status === "open" ? (
                      <>
                        <button
                          className="btn py-1 px-2 text-xs"
                          disabled={busyId === issue.id}
                          onClick={() => setIssueStatus(issue, "resolved")}
                          title="Mark resolved — it reopens automatically if it happens again"
                        >
                          Resolve
                        </button>{" "}
                        <button
                          className="btn py-1 px-2 text-xs"
                          disabled={busyId === issue.id}
                          onClick={() => setIssueStatus(issue, "ignored")}
                          title="Ignore — keeps counting but stays out of the open list"
                        >
                          Ignore
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn py-1 px-2 text-xs"
                        disabled={busyId === issue.id}
                        onClick={() => setIssueStatus(issue, "open")}
                      >
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="h-9 shrink-0 border-t border-border bg-surface px-4 flex items-center gap-3 text-xs text-ink-2">
        <span className="mono">
          {(data?.total ?? 0).toLocaleString()} {data?.total === 1 ? "issue" : "issues"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button className="btn py-0.5 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Prev
          </button>
          <span className="mono px-2">
            {page} / {pages}
          </span>
          <button className="btn py-0.5 px-2 text-xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next ›
          </button>
        </div>
      </div>
    </div>
  );
}
