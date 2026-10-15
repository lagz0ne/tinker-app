import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { serverFile } from "../lib/named.mjs";

const child = `
import assert from "node:assert/strict";
const mode = process.env.PANIC_MODE;
const stop = new AbortController();
const input = { env: process.env, signal: stop.signal, stdout: process.stdout, stderr: process.stderr };
const { default: main } = await import("./dist/server/server.js");
if (["tools-start", "app-start", "tools-start-cleanup", "app-start-cleanup", "missing-tag", "bad-log-level"].includes(mode)) {
  await assert.rejects(main(input), (error) => {
    if (mode === "missing-tag") {
      assert.equal(error.kind, "MissingTag");
      assert.equal(error.payload.label, "mail.from");
    } else if (mode === "bad-log-level") {
      assert.equal(error.kind, "DataValidationFailed");
      assert.equal(error.payload.label, "telemetry.logLevel");
    } else assert.equal(error.message, "proof." + mode);
    return true;
  });
  console.log(mode + ": original failure reported");
  process.exitCode = 1;
} else {
  const server = await main(input);
  if (mode === "close-failure") {
    stop.abort();
    const closing = server.closed;
    await assert.rejects(closing, {message: "proof.close"});
    console.log("close: both owners ended; first failure reported");
  } else {
    const response = await server.fetch(new Request("http://localhost/proof/" + mode));
    if (mode === "rejection") {
      assert.equal(response.status, 200);
      setInterval(() => {}, 1000);
    } else {
      assert.equal(response.status, 500);
      assert.equal((await server.fetch(new Request("http://localhost/api/health"))).status, 200);
      console.log("handler: 500; next request: 200");
      stop.abort();
      await server.closed;
    }
  }
}
`;

for (const app of process.argv.slice(2)) {
  const source = resolve(app);
  const fixture = mkdtempSync(join(tmpdir(), "start-entry-errors-"));
  try {
    cpSync(source, fixture, {
      recursive: true,
      filter: (file) =>
        !["node_modules", "dist", ".tinker", ".tanstack", ".stryker-tmp", "reports"].includes(
          basename(file),
        ),
    });
    symlinkSync(realpathSync(join(source, "node_modules")), join(fixture, "node_modules"));
    const entry = join(fixture, serverFile(fixture).file);
    let main = readFileSync(entry, "utf8");
    for (const marker of [
      'import { createScope, type Scope } from "@tinker/core";',
      "const stop =",
      "extensions: [telemetryExport]",
      "extensions: [startRequests",
      "    const closed = app.closed.then",
      "  const cancelled =",
      "env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)",
    ]) {
      assert.ok(main.includes(marker), `plant must match ${marker}`);
    }

    main = main
      .replace(
        'import { createScope, type Scope } from "@tinker/core";',
        'import { createScope, extension, type Scope } from "@tinker/core";',
      )
      .replace(
        "const stop =",
        `
const mode = env.PANIC_MODE;
const toolsProbe = extension({label: "proof.tools", hooks: {start(event) {
  if (mode?.startsWith("tools-start")) throw new Error("proof." + mode);
  return event.next();
}}});
const appProbe = extension({label: "proof.app", hooks: {start(event) {
  if (mode?.startsWith("app-start")) throw new Error("proof." + mode);
  event.defer(() => { if (mode === "close-failure") throw new Error("proof.close"); });
  return event.next();
}}});
const stop =`,
      )
      .replace(
        "await closed.catch(",
        'await closed.finally(() => { if (mode === "app-start-cleanup") throw new Error("proof.cleanup"); }).catch(',
      )
      .replace(
        "ended(await tools.closed);",
        'if (mode === "tools-start-cleanup") throw new Error("proof.cleanup"); ended(await tools.closed);',
      )
      .replace("extensions: [telemetryExport]", "extensions: [toolsProbe, telemetryExport]")
      .replace("extensions: [startRequests", "extensions: [appProbe, startRequests")
      .replace(
        "  const cancelled =",
        'void tools.closed.then(() => stdout.write("tools.closed\\n"));\n  const cancelled =',
      )
      .replace(
        "    const closed = app.closed.then",
        '    void app.closed.then(() => stdout.write("app.closed\\n"));\n    const closed = app.closed.then',
      )
      .replace(
        "env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)",
        'mode !== "missing-tag" && env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)',
      );
    writeFileSync(entry, main);
    mkdirSync(join(fixture, "src/routes/proof"), { recursive: true });
    writeFileSync(
      join(fixture, "src/routes/proof/handler.ts"),
      `
import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "~/components/requests";
export const Route = createFileRoute("/proof/handler")({server: {middleware: [startRequests.middleware], handlers: {
  GET: ({context}) => { context.session.onClose(() => { process.stdout.write("request.closed\\n"); }); throw new Error("proof.handler"); },
}}});
`,
    );
    writeFileSync(
      join(fixture, "src/routes/proof/rejection.ts"),
      `
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/proof/rejection")({server: {handlers: {
  GET: () => { Promise.reject(new Error("proof.unhandled", { cause: new Error("proof.cause") })); return new Response("sent"); },
}}});
`,
    );
    const build = spawnSync("vp", ["build"], { cwd: fixture, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);

    for (const mode of [
      "tools-start",
      "app-start",
      "tools-start-cleanup",
      "app-start-cleanup",
      "missing-tag",
      "bad-log-level",
      "handler",
      "close-failure",
      "rejection",
    ]) {
      const ran = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
        cwd: fixture,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PANIC_MODE: mode,
          LOG_LEVEL: mode === "bad-log-level" ? "info" : "30",
        },
        encoding: "utf8",
        timeout: 15000,
      });
      const log = ran.stdout + ran.stderr;
      assert.equal(ran.status, ["handler", "close-failure"].includes(mode) ? 0 : 1, log);
      const lines = ran.stdout.split("\n");
      assert.equal(
        lines.filter((line) => line === "tools.closed").length,
        mode === "bad-log-level" ? 0 : 1,
        log,
      );
      assert.equal(
        lines.filter((line) => line === "app.closed").length,
        ["tools-start", "tools-start-cleanup", "bad-log-level"].includes(mode) ? 0 : 1,
        log,
      );
      if (!["tools-start", "tools-start-cleanup", "bad-log-level"].includes(mode)) {
        assert.ok(lines.indexOf("app.closed") < lines.indexOf("tools.closed"), log);
      }

      if (
        [
          "tools-start",
          "app-start",
          "tools-start-cleanup",
          "app-start-cleanup",
          "missing-tag",
          "bad-log-level",
        ].includes(mode)
      ) {
        assert.ok(lines.includes(mode + ": original failure reported"), log);
      }
      if (mode.endsWith("-cleanup")) {
        assert.ok(ran.stderr.includes("close failed: Error: proof.cleanup"), log);
      }
      if (mode === "handler") {
        assert.ok(lines.includes("handler: 500; next request: 200"), log);
        assert.ok(lines.includes("request.closed"), log);
      }
      if (mode === "close-failure") {
        assert.ok(lines.includes("close: both owners ended; first failure reported"), log);
      }
      if (mode === "rejection") {
        assert.ok(ran.stderr.includes("server: unhandled rejection Error: proof.unhandled"), log);
        assert.ok(ran.stderr.includes("[cause]: Error: proof.cause"), log);
      }
      console.log(
        `PASS: planted ${mode}; correct failure, stop order, and one close per started root.`,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
