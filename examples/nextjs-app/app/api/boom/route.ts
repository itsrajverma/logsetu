import { withLogSetu } from "logsetu-js/next";

export const GET = withLogSetu(async () => {
  throw new Error("Route handler exploded");
});
