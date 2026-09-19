"use client";

import { useState } from "react";
import type { StatsResponse } from "@/lib/types";
import { LEVEL_ORDER, levelColor } from "@/lib/levels";

export function StatsBar({
  stats,
  activeLevels,
  onToggleLevel,
}: {
  stats: StatsResponse | null;
  activeLevels: string[];
  onToggleLevel: (level: string) => void;
}) {
  return (
    <div className="border-b border-border bg-surface px-4 py-2 flex items-stretch gap-4 overflow-x-auto">
      {/* Stat tiles double as the legend: swatch + label + value, never color alone */}
      <div className="flex items-center gap-1 shrink-0">
        {LEVEL_ORDER.map((lvl) => {
          const on = activeLevels.length === 0 || activeLevels.includes(lvl);
          const n = stats?.last24h[lvl] ?? 0;
          return (
            <button
              key={lvl}
              type="button"
              onClick={() => onToggleLevel(lvl)}
              className={`text-left rounded-md px-2.5 py-1 hover:bg-surface-2 transition-opacity ${on ? "" : "opacity-40"}`}
              title={`${lvl}: ${n.toLocaleString()} in the last 24h. Click to filter.`}
            >
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-3">
                <span className="h-2 w-2 rounded-sm" style={{ background: levelColor(lvl) }} aria-hidden />
                {lvl}
              </div>
              <div className="mono text-sm text-ink leading-tight">{stats ? n.toLocaleString() : "–"}</div>
            </button>
          );
        })}
        <div className="text-left px-2.5 py-1 border-l border-border ml-1">
          <div className="text-[11px] uppercase tracking-wide text-ink-3">Total</div>
          <div className="mono text-sm text-ink leading-tight">{stats ? stats.total.toLocaleString() : "–"}</div>
        </div>
      </div>

      <div className="flex-1 min-w-64">
        <HourlyChart stats={stats} />
      </div>
    </div>
  );
}

function HourlyChart({ stats }: { stats: StatsResponse | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = stats?.series ?? [];
  const totals = series.map((b) => LEVEL_ORDER.reduce((s, l) => s + b.counts[l], 0));
  const max = Math.max(1, ...totals);
  const H = 44;

  return (
    <div className="relative h-full flex flex-col justify-end" onMouseLeave={() => setHover(null)}>
      <div className="flex items-end gap-[3px] h-11" role="img" aria-label="Logs per hour, last 24 hours, by level">
        {series.length === 0
          ? Array.from({ length: 24 }, (_, i) => <div key={i} className="flex-1 bg-surface-3 rounded-t" style={{ height: 2 }} />)
          : series.map((b, i) => {
              const total = totals[i] ?? 0;
              const px = total === 0 ? 0 : Math.max(3, Math.round((total / max) * H));
              return (
                <div
                  key={b.bucket}
                  className="flex-1 flex flex-col-reverse justify-start cursor-crosshair"
                  style={{ height: H }}
                  onMouseEnter={() => setHover(i)}
                >
                  {total === 0 ? (
                    <div className="bg-surface-3 rounded-t" style={{ height: 2 }} />
                  ) : (
                    LEVEL_ORDER.filter((l) => b.counts[l] > 0).map((l, idx, arr) => (
                      <div
                        key={l}
                        style={{
                          height: Math.max(1, (b.counts[l] / total) * px),
                          background: levelColor(l),
                          marginTop: idx === arr.length - 1 ? 0 : 2, // 2px surface gap between stacked segments
                          borderTopLeftRadius: idx === arr.length - 1 ? 3 : 0,
                          borderTopRightRadius: idx === arr.length - 1 ? 3 : 0,
                          opacity: hover === null || hover === i ? 1 : 0.55,
                        }}
                      />
                    ))
                  )}
                </div>
              );
            })}
      </div>
      <div className="flex justify-between text-[10px] text-ink-3 mono mt-0.5">
        <span>24h ago</span>
        <span>now</span>
      </div>

      {hover !== null && series[hover] && (
        <div
          className="absolute bottom-full mb-1 z-20 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg pointer-events-none"
          style={{ left: `${(hover / 24) * 100}%`, transform: hover > 16 ? "translateX(-100%)" : undefined }}
        >
          <div className="text-ink-3 mono mb-1">
            {new Date(series[hover].bucket).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} –{" "}
            {new Date(new Date(series[hover].bucket).getTime() + 3_600_000).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
          {LEVEL_ORDER.map((l) => (
            <div key={l} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-sm" style={{ background: levelColor(l) }} aria-hidden />
              <span className="w-10 text-ink-2">{l}</span>
              <span className="mono text-ink ml-auto">{series[hover]!.counts[l].toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
