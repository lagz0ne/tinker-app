import { copyProofApp, proofEnv } from "./proof-app.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

async function fetchWhenListening(url, server) {
  const deadline = AbortSignal.timeout(30000);
  while (true) {
    deadline.throwIfAborted();
    assert.equal(server.exitCode, null, "Server exited before accepting a request");
    try {
      return await fetch(url, { signal: deadline });
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
      await setImmediate();
    }
  }
}

/** Exercise the installed serve script and Start route with the shipped database and mail presets. */
export async function checkServe(source) {
  const proof = await mkdtemp(join(tmpdir(), "start-native-response-"));
  let server;
  let output = "";
  try {
    await copyProofApp(source, proof);
    await writeFile(
      join(proof, "src/routes/proof.response.ts"),
      `import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/proof/response")({
  server: { handlers: { GET: () => Response.json({ ok: true }) } },
});
`,
    );
    const built = spawnSync(join(source, "node_modules/.bin/vp"), ["build"], {
      cwd: proof,
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    await new Promise((done) => listener.close(done));
    server = spawn(
      process.execPath,
      [join(source, "node_modules/@tinker/start/bin/tinker.mjs"), "serve"],
      {
        cwd: proof,
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(address.port),
          ...proofEnv,
          PUBLIC_ORIGIN: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", (data) => (output += data));
    server.stderr.on("data", (data) => (output += data));
    const response = await fetchWhenListening(
      `http://127.0.0.1:${address.port}/proof/response`,
      server,
    );
    const body = await response.text();
    console.log(`GET /proof/response: ${response.status} ${body}`);
    assert.equal(response.status, 200, output + body);
    assert.deepEqual(JSON.parse(body), { ok: true });
    console.log("PASS built starter serves native Response.json");
  } finally {
    if (server && server.exitCode === null) {
      const ended = once(server, "close");
      server.kill("SIGTERM");
      await ended;
    }
    await rm(proof, { recursive: true, force: true });
  }
}

if (import.meta.main) await checkServe(resolve(import.meta.dirname, ".."));
