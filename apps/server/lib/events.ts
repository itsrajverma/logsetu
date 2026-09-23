import { EventEmitter } from "node:events";
import type { IssueChange } from "./grouping";
import type { LogRecord } from "./logs";

// In-process pub/sub for freshly ingested logs. Powers SSE streaming (and anything else that wants
// to react to new logs). Single-instance only — with several replicas, each only sees its own ingests.

type Bus = EventEmitter;
const g = globalThis as { __logsetuBus?: Bus };

function bus(): Bus {
  if (!g.__logsetuBus) {
    g.__logsetuBus = new EventEmitter() as Bus;
    g.__logsetuBus.setMaxListeners(0); // one listener per open dashboard tab
  }
  return g.__logsetuBus;
}

export type LogsListener = (logs: LogRecord[]) => void;

export function publishLogs(projectId: string, logs: LogRecord[]) {
  if (logs.length === 0) return;
  bus().emit(`logs:${projectId}`, logs);
  bus().emit("logs:*", logs);
}

/** Subscribe to new logs for one project, or every project with "*". Returns an unsubscribe fn. */
export function subscribeLogs(projectId: string | "*", fn: LogsListener): () => void {
  const event = `logs:${projectId}`;
  bus().on(event, fn);
  return () => bus().off(event, fn);
}

export function listenerCount(projectId: string | "*"): number {
  return bus().listenerCount(`logs:${projectId}`);
}

// Issue lifecycle changes from error grouping (new issue, regression, more events).
export type IssuesListener = (projectId: string, changes: IssueChange[]) => void;

export function publishIssues(projectId: string, changes: IssueChange[]) {
  if (changes.length > 0) bus().emit("issues", projectId, changes);
}

export function subscribeIssues(fn: IssuesListener): () => void {
  bus().on("issues", fn);
  return () => bus().off("issues", fn);
}
