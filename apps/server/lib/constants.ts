export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const MAX_BATCH_SIZE = 500;
export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_META_BYTES = 64 * 1024;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;
export const SESSION_COOKIE = "logsetu_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
