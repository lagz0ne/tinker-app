import main from "../dist/server/server.js";
const env = { OTEL_SERVICE_NAME: "small", VICTORIA_TRACES_URL: "http://127.0.0.1:9/t", VICTORIA_LOGS_URL: "http://127.0.0.1:9/l" };
const sink = { write: (_s: string) => {} };
const stop = new AbortController();
const app = await main({ env, args: [], signal: stop.signal, stdout: sink, stderr: { write: (s: string) => process.stderr.write(s) }, exit: (c: number, e?: unknown) => console.error("exit", c, e) });
const r = await app.fetch(new Request("http://127.0.0.1/"));
console.log(await r.text());
stop.abort();
await app.closed;
