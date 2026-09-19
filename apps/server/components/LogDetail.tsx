"use client";

import type { LogDTO } from "@/lib/types";
import type { Filters } from "./useFilters";
import { CopyButton, LevelBadge, formatDateTime } from "./ui";

const STACK_KEYS = ["stack", "stacktrace", "stack_trace", "traceback", "exc_text"];

export function LogDetail({
  log,
  onClose,
  onFilter,
}: {
  log: LogDTO;
  onClose: () => void;
  onFilter: (patch: Partial<Filters>) => void;
}) {
  const meta = (log.meta ?? {}) as Record<string, unknown>;
  const stackKey = STACK_KEYS.find((k) => typeof meta[k] === "string");
  const stack = stackKey ? (meta[stackKey] as string) : null;
  const rest = Object.fromEntries(Object.entries(meta).filter(([k]) => k !== stackKey));
  const hasMeta = Object.keys(rest).length > 0;

  return (
    <aside className="w-[min(560px,50vw)] shrink-0 border-l border-border bg-surface flex flex-col min-h-0">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <LevelBadge level={log.level} size="md" />
        <span className="text-xs text-ink-2 mono">{formatDateTime(log.timestamp)}</span>
        <div className="ml-auto flex items-center gap-1">
          <CopyButton text={() => JSON.stringify(log, null, 2)} label="Copy JSON" />
          <button className="btn py-1 px-2 text-xs" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4 text-sm">
        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">Message</h3>
          <pre className="mono whitespace-pre-wrap break-words text-ink text-[13px] leading-relaxed">{log.message}</pre>
        </section>

        <section className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <Field label="Source">
            <FilterLink onClick={() => onFilter({ source: log.source })}>{log.source}</FilterLink>
          </Field>
          <Field label="Environment">
            <FilterLink onClick={() => onFilter({ environment: log.environment })}>{log.environment}</FilterLink>
          </Field>
          <Field label="Received">
            <span className="mono text-ink-2">{formatDateTime(log.createdAt)}</span>
          </Field>
          <Field label="ID">
            <span className="mono text-ink-2">{log.id}</span>
          </Field>
        </section>

        {stack && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">Stack trace</h3>
            <pre className="mono text-[12px] leading-relaxed whitespace-pre overflow-x-auto bg-bg border border-border rounded-md p-3 text-level-error/90">
              {stack}
            </pre>
          </section>
        )}

        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-ink-3 mb-1">Metadata</h3>
          {hasMeta ? (
            <pre className="mono text-[12px] leading-relaxed whitespace-pre-wrap break-words bg-bg border border-border rounded-md p-3 text-ink-2">
              {JSON.stringify(rest, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-ink-3">No metadata</p>
          )}
        </section>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-ink-3">{label}</span>
      <span className="truncate">{children}</span>
    </>
  );
}

function FilterLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className="text-ink hover:text-accent hover:underline" onClick={onClick} title="Filter by this value">
      {children}
    </button>
  );
}
