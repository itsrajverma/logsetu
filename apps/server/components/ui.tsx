"use client";

import { useState } from "react";
import { levelColor } from "@/lib/levels";

export function LevelBadge({ level, size = "sm" }: { level: string; size?: "sm" | "md" }) {
  const color = levelColor(level);
  return (
    <span
      className={`badge ${size === "md" ? "text-xs px-2 py-1" : ""}`}
      style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}
    >
      {level}
    </span>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  className = "",
  title,
}: {
  text: string | (() => string);
  label?: string;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title ?? label}
      className={`btn py-1 px-2 text-xs ${className}`}
      onClick={async (e) => {
        e.stopPropagation();
        const value = typeof text === "function" ? text() : text;
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-ink-3 border-t-transparent animate-spin" aria-label="Loading" />
  );
}
