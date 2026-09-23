import type { LogLevel } from "./constants";

export type ProjectSummary = {
  id: string;
  name: string;
  apiKey: string;
  retentionDays: number | null;
  createdAt: string;
  logCount: number;
};

export type LogDTO = {
  id: string;
  projectId: string;
  level: LogLevel | string;
  message: string;
  source: string;
  environment: string;
  meta: Record<string, unknown> | null;
  timestamp: string;
  createdAt: string;
  issueId: string | null;
};

export type IssueDTO = {
  id: string;
  projectId: string;
  title: string;
  culprit: string | null;
  level: string;
  source: string;
  status: "open" | "resolved" | "ignored";
  count: number;
  last24h: number;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
};

export type IssuesResponse = {
  issues: IssueDTO[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  counts: Record<"open" | "resolved" | "ignored", number>;
};

export type LogsResponse = {
  logs: LogDTO[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
};

export type StatsResponse = {
  total: number;
  last24h: Record<LogLevel, number>;
  series: { bucket: string; counts: Record<LogLevel, number> }[];
  sources: string[];
  environments: string[];
};
