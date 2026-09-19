"use client";

import type { LogDTO } from "@/lib/types";
import { levelColor } from "@/lib/levels";
import { CopyButton, LevelBadge, formatDate, formatTime } from "./ui";

export function LogTable({
  logs,
  selectedId,
  onSelect,
}: {
  logs: LogDTO[];
  selectedId: string | null;
  onSelect: (log: LogDTO) => void;
}) {
  return (
    <table className="w-full text-[13px] border-collapse">
      <thead className="sticky top-0 z-10 bg-surface text-ink-3 text-[11px] uppercase tracking-wide">
        <tr className="border-b border-border">
          <th className="text-left font-medium px-4 py-1.5 w-36">Time</th>
          <th className="text-left font-medium px-2 py-1.5 w-16">Level</th>
          <th className="text-left font-medium px-2 py-1.5">Message</th>
          <th className="text-left font-medium px-2 py-1.5 w-36 hidden md:table-cell">Source</th>
          <th className="text-left font-medium px-2 py-1.5 w-24 hidden lg:table-cell">Env</th>
          <th className="w-16" />
        </tr>
      </thead>
      <tbody>
        {logs.map((log) => {
          const active = log.id === selectedId;
          return (
            <tr
              key={log.id}
              onClick={() => onSelect(log)}
              className={`group border-b border-border/60 cursor-pointer align-top ${
                active ? "bg-surface-3" : "hover:bg-surface-2"
              }`}
              style={{ boxShadow: `inset 3px 0 0 ${levelColor(log.level)}` }}
            >
              <td className="px-4 py-1.5 mono text-ink-2 whitespace-nowrap">
                <span className="text-ink-3">{formatDate(log.timestamp)}</span> {formatTime(log.timestamp)}
              </td>
              <td className="px-2 py-1.5">
                <LevelBadge level={log.level} />
              </td>
              <td className="px-2 py-1.5 mono text-ink truncate max-w-0">
                <span className="line-clamp-2 break-words">{log.message}</span>
              </td>
              <td className="px-2 py-1.5 text-ink-2 truncate hidden md:table-cell">{log.source}</td>
              <td className="px-2 py-1.5 text-ink-2 truncate hidden lg:table-cell">{log.environment}</td>
              <td className="px-2 py-1 text-right">
                <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={() => JSON.stringify(log, null, 2)} label="JSON" title="Copy log as JSON" />
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
