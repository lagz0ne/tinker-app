import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

import { copyProofApp, proofEnv } from "./proof-app.mjs";

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

/** A stopped host lets startup finish, closes app before tools, and never listens. */
async function signalCase(source, proof, extra, marker, expected, appCount) {
  const child = spawn(
    process.execPath,
    [join(source, "node_modules/@tinker/start/bin/tinker.mjs"), "serve"],
    {
      cwd: proof,
      env: { ...process.env, ...proofEnv, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ended = once(child, "close");
  let output = "";

  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });

  try {
    await new Promise((done, fail) => {
      const timeout = AbortSignal.timeout(30000);
      timeout.addEventListener(
        "abort",
        () => fail(new Error(output || "Host never reached the marker")),
        { once: true },
      );
      child.stdout.on("data", () => {
        if (output.includes(marker)) done();
      });
      child.once("error", fail);
      child.once("exit", () => fail(new Error(output)));
    });

    child.kill("SIGTERM");
    const [code, signal] = await Promise.race([
      ended,
      new Promise((_done, fail) => {
        AbortSignal.timeout(30000).addEventListener(
          "abort",
          () => fail(new Error(output || "Host did not stop")),
          { once: true },
        );
      }),
    ]);

    assert.equal(signal, null, output);
    assert.equal(code, expected, output);
    assert.equal(output.split("proof.app.closed\n").length - 1, appCount, output);
    assert.equal(output.split("proof.tools.closed\n").length - 1, 1, output);

    if (appCount) {
      assert.ok(
        output.indexOf("proof.app.closed\n") < output.indexOf("proof.tools.closed\n"),
        output,
      );
    }

    if (marker !== "tinker serve:") {
      const finished = marker.replace("waiting", "finished");
      assert.ok(output.includes(finished), output);
      assert.ok(
        output.indexOf(finished) <
          output.indexOf(appCount ? "proof.app.closed\n" : "proof.tools.closed\n"),
        output,
      );
      assert.ok(!output.includes("tinker serve:"), output);
    }
    if (extra.PROOF_TOOLS_FAIL) assert.ok(output.includes("proof.tools.failure"), output);
    console.log(`PASS: SIGTERM ${marker}; started roots close in order; EXIT ${code}.`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await ended;
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
    const command = join(proof, "cmds/server.ts");
    const main = await readFile(command, "utf8");
    assert.ok(main.includes("  const stop ="));
    const planted = main
      .replace(
        'import { createScope } from "@tinker/core";',
        'import { createScope, extension } from "@tinker/core";',
      )
      .replace("  const appStop =", '  stdout.write("proof.main\\n"); const appStop =')
      .replace(
        "  const stop =",
        `
  const toolsProbe = extension({ label: "proof.tools", hooks: { start(ctx) {
    ctx.defer(() => { stdout.write("proof.tools.closed\\n"); });
    if (env.PROOF_TOOLS_WAIT) {
      stdout.write("proof.tools.waiting\\n");
      return new Promise<void>((done) => setTimeout(done, 1500)).then(() => {
        stdout.write("proof.tools.finished\\n");
        if (env.PROOF_TOOLS_FAIL) throw new Error("proof.tools.failure");
        return ctx.next();
      });
    }
    return ctx.next();
  } } });
  const appProbe = extension({ label: "proof.app", hooks: { start(ctx) {
    ctx.defer(() => { stdout.write("proof.app.closed\\n"); if (env.PROOF_CLOSE_FAIL) throw new Error("proof.close"); });
    return ctx.next();
  } } });
  const stop =`,
      )
      .replace("extensions: [telemetryExport]", "extensions: [toolsProbe, telemetryExport]")
      .replace("extensions: [startRequests", "extensions: [appProbe, startRequests");
    await writeFile(command, planted);
    const migrationFile = join(proof, "tinker/components/database/database.server.ts");
    const migration = await readFile(migrationFile, "utf8");
    assert.ok(migration.includes("run: async ({ database, pgCore, migrator }) => {"));
    await writeFile(
      migrationFile,
      migration
        .replace("    database,\n    pgCore:", "    database,\n    url: databaseUrl,\n    pgCore:")
        .replace(
          "run: async ({ database, pgCore, migrator }) => {",
          `run: async ({ database, pgCore, migrator, url }) => {
      if (url.hostname === "hold") {
        process.stdout.write("proof.migration.waiting\\n");
        await new Promise<void>((done) => setTimeout(done, 1500));
        process.stdout.write("proof.migration.finished\\n");
      }`,
        ),
    );

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
    try {
      // An occupied port makes a premature listen fail with EADDRINUSE instead of MissingTag.
      const failed = spawnSync(
        process.execPath,
        [join(source, "node_modules/@tinker/start/bin/tinker.mjs"), "serve"],
        {
          cwd: proof,
          env: { ...process.env, ...proofEnv, SMTP_FROM: undefined, PORT: String(address.port) },
          encoding: "utf8",
          timeout: 30000,
        },
      );

      assert.notEqual(failed.status, null, failed.stdout + failed.stderr);
      assert.equal(failed.status, 78, failed.stdout + failed.stderr);
      assert.ok(failed.stderr.includes("MissingTag"), failed.stderr);
      assert.ok(failed.stderr.includes("mail.from"), failed.stderr);
      assert.ok(!failed.stderr.includes("EADDRINUSE"), failed.stderr);
      assert.ok(!failed.stdout.includes("tinker serve:"), failed.stdout);
      console.log("PASS: tinker serve rejects MissingTag mail.from before attempting to listen.");
    } finally {
      await new Promise((done) => listener.close(done));
    }

    const listenFailed = spawnSync(
      process.execPath,
      [join(source, "node_modules/@tinker/start/bin/tinker.mjs"), "serve"],
      {
        cwd: proof,
        env: { ...process.env, ...proofEnv, PORT: "-1", PROOF_CLOSE_FAIL: "1" },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    const listenLog = listenFailed.stdout + listenFailed.stderr;
    assert.equal(listenFailed.status, 1, listenLog);
    assert.ok(listenFailed.stderr.includes("ERR_SOCKET_BAD_PORT"), listenLog);
    assert.match(listenFailed.stderr, /after exit 1:.*proof.close/s, listenLog);
    assert.ok(!listenFailed.stdout.includes("tinker serve:"), listenLog);
    assert.ok(
      listenLog.indexOf("proof.app.closed\n") < listenLog.indexOf("proof.tools.closed\n"),
      listenLog,
    );
    console.log(
      "PASS: listen failure reports its close failure and ends app before tools; EXIT 1.",
    );

    await signalCase(source, proof, { PROOF_TOOLS_WAIT: "1" }, "proof.tools.waiting", 143, 1);
    await signalCase(
      source,
      proof,
      { PROOF_TOOLS_WAIT: "1", PROOF_TOOLS_FAIL: "1" },
      "proof.tools.waiting",
      143,
      0,
    );
    await signalCase(
      source,
      proof,
      { DATABASE_URL: "postgres://hold" },
      "proof.migration.waiting",
      143,
      1,
    );
    await signalCase(
      source,
      proof,
      { PROOF_CLOSE_FAIL: "1", PORT: String(address.port) },
      "tinker serve:",
      143,
      1,
    );

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
    const replies = await Promise.all(
      [1, 2].map(() => fetch(`http://127.0.0.1:${address.port}/proof/response`)),
    );
    for (const reply of replies) assert.equal((await reply.json()).ok, true);
    assert.equal(output.split("proof.main\n").length - 1, 1, "the prod host calls main once");
    const ended = once(server, "close");
    server.kill("SIGTERM");
    const [code, signal] = await ended;
    assert.equal(code, 143, output);
    assert.equal(signal, null, output);
    assert.ok(
      output.indexOf("proof.app.closed\n") < output.indexOf("proof.tools.closed\n"),
      output,
    );
    assert.equal(output.split("proof.app.closed\n").length - 1, 1, output);
    assert.equal(output.split("proof.tools.closed\n").length - 1, 1, output);
    console.log(
      "PASS built starter serves native Response.json; prod calls main once; SIGTERM closes app then tools with EXIT 143",
    );
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
