"use client";

import { useState } from "react";
import { LogSetuErrorBoundary } from "logsetu-js/react";
import { logger } from "@/lib/logsetu";

function Crasher({ crash }: { crash: boolean }) {
  if (crash) throw new Error("Render crash from <Crasher />");
  return <p>Component is healthy.</p>;
}

export function Playground() {
  const [crash, setCrash] = useState(false);
  const [status, setStatus] = useState("");
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
      <button id="info" onClick={() => { logger.info("Button clicked", { button: "info", userId: 123 }); setStatus("info sent"); }}>
        logger.info
      </button>
      <button id="error" onClick={() => { logger.error("Payment failed", { error: new Error("card declined"), orderId: 456 }); setStatus("error sent"); }}>
        logger.error with Error
      </button>
      <button id="capture" onClick={() => { try { JSON.parse("{bad"); } catch (e) { logger.captureException(e, { where: "capture button" }); } setStatus("exception captured"); }}>
        captureException
      </button>
      <button id="flush" onClick={async () => { await logger.flush(); setStatus("flushed"); }}>
        flush
      </button>
      <button id="api-ok" onClick={async () => { const r = await fetch("/api/hello"); setStatus(`api ${r.status}`); }}>
        call /api/hello (wrapped, ok)
      </button>
      <button id="api-boom" onClick={async () => { const r = await fetch("/api/boom"); setStatus(`api ${r.status}`); }}>
        call /api/boom (wrapped, throws)
      </button>
      <button id="crash" onClick={() => setCrash(true)}>crash a component</button>
      <LogSetuErrorBoundary
        meta={{ area: "playground" }}
        fallback={(err, reset) => (
          <div id="fallback">
            Boundary caught: {err.message} <button onClick={() => { setCrash(false); reset(); }}>reset</button>
          </div>
        )}
      >
        <Crasher crash={crash} />
      </LogSetuErrorBoundary>
      <p id="status">{status}</p>
    </div>
  );
}
