import type { LogLevel } from "./constants";

// Validated for the dark surface (#141416): passes lightness band, contrast, and
// normal-vision separation; warn/error sit in the CVD floor band so levels are
// always paired with a text label and chart segments carry a 2px gap.
export const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "#8b8f98",
  info: "#3987e5",
  warn: "#c98500",
  error: "#e34948",
  fatal: "#9085e9",
};

export const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];

export function levelColor(level: string): string {
  return LEVEL_COLORS[level as LogLevel] ?? LEVEL_COLORS.debug;
}
