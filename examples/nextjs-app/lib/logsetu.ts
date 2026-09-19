"use client";

import { LogSetu } from "logsetu-js";

// Browser-side client. Created once per page load.
export const logger = LogSetu.init({
  apiKey: process.env.NEXT_PUBLIC_LOGSETU_API_KEY ?? "",
  endpoint: process.env.NEXT_PUBLIC_LOGSETU_ENDPOINT ?? "http://localhost:8686",
  environment: process.env.NODE_ENV,
  source: "nextjs-web",
  debug: true,
});
