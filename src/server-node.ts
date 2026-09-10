import { serve } from "@hono/node-server";
import app from "./index.js";
import { initCrashReporting } from "./telemetry.js";

initCrashReporting();

// Node entry point. Passes process.env as the Hono `env`, so every downstream
// `c.env.X` read resolves against process.env.
const port = Number(process.env.PORT ?? 4100);

serve({
  fetch: (req: Request) => app.fetch(req, process.env as unknown as never),
  port,
});

// eslint-disable-next-line no-console
console.log(`critalarm server listening on http://localhost:${port}`);
