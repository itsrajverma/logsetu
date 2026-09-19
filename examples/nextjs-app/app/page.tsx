import { LogSetu } from "logsetu-js";
import { Playground } from "./playground";

export const dynamic = "force-dynamic";

export default function Home() {
  // Server Component: uses the client initialised in instrumentation.ts
  LogSetu.info("Home page rendered on the server", { path: "/" });
  return (
    <main>
      <h1>logsetu-js example</h1>
      <Playground />
    </main>
  );
}
