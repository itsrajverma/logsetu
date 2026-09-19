import { createOnRequestError, registerLogSetu } from "logsetu-js/next";

export function register() {
  registerLogSetu({
    apiKey: process.env.LOGSETU_API_KEY ?? "",
    endpoint: process.env.LOGSETU_ENDPOINT ?? "http://localhost:8686",
    environment: process.env.NODE_ENV,
    source: "nextjs-server",
    debug: true,
  });
}

// Captures errors from Server Components, Route Handlers, Server Actions and middleware.
export const onRequestError = createOnRequestError();
