// In-process host: starts the built server main, then calls fetch N times.
// No socket, so the profile shows only the app's own work.
import main from "../dist/server/server.js";

const N = Number(process.env.N ?? 2000);
const paths = (process.env.PATHS ?? "/,/api/health").split(",");
const env = {
  OTEL_SERVICE_NAME: "small",
  VICTORIA_TRACES_URL: "http://127.0.0.1:9/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:9/logs",
  LOG_LEVEL: "50",
};
let logged = 0;
const out = { write: (s: string) => { logged += s.length; } };
const err = { write: (s: string) => process.stderr.write(s) };
const stop = new AbortController();

const t0 = performance.now();
const app = await main({ env, args: [], signal: stop.signal, stdout: out, stderr: err, exit: (c: number, e?: unknown) => { console.error("exit", c, e); } });
const t1 = performance.now();
let bytes = 0;
for (const p of paths) {
  const r = await app.fetch(new Request("http://127.0.0.1" + p));
  const body = await r.text();
  console.log(p, r.status, body.slice(0, 120).replace(/\n/g, " "));
}
for (let i = 0; i < N; i++) {
  const r = await app.fetch(new Request("http://127.0.0.1" + paths[i % paths.length]));
  bytes += (await r.text()).length;
}
const t2 = performance.now();
console.log(`start_ms=${(t1 - t0).toFixed(1)} loop_ms=${(t2 - t1).toFixed(1)} n=${N} bytes=${bytes} logged=${logged}`);
stop.abort();
await app.closed;
