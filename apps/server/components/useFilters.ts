"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

export const RANGE_PRESETS = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
} as const;
export type RangePreset = keyof typeof RANGE_PRESETS;

export type Filters = {
  level: string[];
  source: string;
  environment: string;
  search: string;
  range: RangePreset | "all" | "custom";
  from: string;
  to: string;
  page: number;
};

export function useFilters(projectId: string) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const filters = useMemo<Filters>(() => {
    const range = (sp.get("range") as Filters["range"] | null) ?? "24h";
    return {
      level: (sp.get("level") ?? "").split(",").filter(Boolean),
      source: sp.get("source") ?? "",
      environment: sp.get("environment") ?? "",
      search: sp.get("search") ?? "",
      range: range in RANGE_PRESETS || range === "all" || range === "custom" ? range : "24h",
      from: sp.get("from") ?? "",
      to: sp.get("to") ?? "",
      page: Math.max(1, Number(sp.get("page") ?? 1) || 1),
    };
  }, [sp]);

  const update = useCallback(
    (patch: Partial<Filters>) => {
      const next: Filters = { ...filters, ...patch };
      if (!("page" in patch)) next.page = 1;
      const q = new URLSearchParams();
      q.set("project", projectId);
      if (next.level.length) q.set("level", next.level.join(","));
      if (next.source) q.set("source", next.source);
      if (next.environment) q.set("environment", next.environment);
      if (next.search) q.set("search", next.search);
      if (next.range !== "24h") q.set("range", next.range);
      if (next.range === "custom") {
        if (next.from) q.set("from", next.from);
        if (next.to) q.set("to", next.to);
      }
      if (next.page > 1) q.set("page", String(next.page));
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [filters, pathname, projectId, router],
  );

  return { filters, update };
}

/** Build the query string for /api/v1/logs from the filter state (computes relative ranges at call time). */
export function filtersToQuery(projectId: string, f: Filters, limit: number): URLSearchParams {
  const q = new URLSearchParams({ projectId, page: String(f.page), limit: String(limit) });
  if (f.level.length) q.set("level", f.level.join(","));
  if (f.source) q.set("source", f.source);
  if (f.environment) q.set("environment", f.environment);
  if (f.search) q.set("search", f.search);
  if (f.range === "custom") {
    if (f.from) q.set("from", new Date(f.from).toISOString());
    if (f.to) q.set("to", new Date(f.to).toISOString());
  } else if (f.range !== "all") {
    q.set("from", new Date(Date.now() - RANGE_PRESETS[f.range]).toISOString());
  }
  return q;
}
