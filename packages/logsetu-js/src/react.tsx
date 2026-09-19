import { Component, createContext, useContext, type ErrorInfo, type ReactNode } from "react";
import { LogSetu, type LogSetuClient, type LogMeta } from "./index";

const LogSetuContext = createContext<LogSetuClient | null>(null);

/** Optionally scope a client to a React subtree. Without it, hooks use the default `LogSetu.init` client. */
export function LogSetuProvider({ client, children }: { client: LogSetuClient; children: ReactNode }) {
  return <LogSetuContext.Provider value={client}>{children}</LogSetuContext.Provider>;
}

/** Returns the nearest LogSetu client (provider or default). */
export function useLogSetu(): LogSetuClient {
  return useContext(LogSetuContext) ?? LogSetu.get();
}

export interface LogSetuErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of the crashed subtree. A function receives the error and a reset callback. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Extra metadata attached to the report. */
  meta?: LogMeta;
  /** Use a specific client instead of the provider/default one. */
  client?: LogSetuClient;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/** Reports uncaught render errors to LogSetu, then shows `fallback` (or nothing). */
export class LogSetuErrorBoundary extends Component<LogSetuErrorBoundaryProps, State> {
  static override contextType = LogSetuContext;
  declare context: LogSetuClient | null;
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    const client = this.props.client ?? this.context ?? LogSetu.get();
    client.captureException(error, {
      componentStack: info.componentStack ?? undefined,
      boundary: "LogSetuErrorBoundary",
      ...(typeof window !== "undefined" ? { url: window.location.href } : {}),
      ...(this.props.meta ?? {}),
    });
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback(error, this.reset);
    return fallback ?? null;
  }
}
