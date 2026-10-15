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
if (["tools-start", "app-start", "missing-tag", "bad-log-level"].includes(mode)) {
  await assert.rejects(import("./dist/server/server.js"), (error) => {
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
  const { default: server } = await import("./dist/server/server.js");
  if (mode === "close-failure") {
    const closing = server.close();
    assert.equal(server.close(), closing);
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
      await server.close();
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
      filter: (file) => !["node_modules", "dist", ".tinker", ".tanstack"].includes(basename(file)),
    });
    symlinkSync(realpathSync(join(source, "node_modules")), join(fixture, "node_modules"));
    const entry = join(fixture, serverFile(fixture).file);
    let main = readFileSync(entry, "utf8");
    for (const marker of [
      'import { createScope } from "@tinker/core";',
      "const stop =",
      "extensions: [telemetryExport]",
      "extensions: [startRequests",
      "  close = once(",
      "let close = once(",
      "process.env.SMTP_FROM !== undefined && mail.mailFrom(process.env.SMTP_FROM)",
    ]) {
      assert.ok(main.includes(marker), `plant must match ${marker}`);
    }

    main = main
      .replace(
        'import { createScope } from "@tinker/core";',
        'import { createScope, extension } from "@tinker/core";',
      )
      .replace(
        "const stop =",
        `
const mode = process.env.PANIC_MODE;
const toolsProbe = extension({label: "proof.tools", hooks: {start(event) {
  if (mode === "tools-start") throw new Error("proof.tools-start");
  return event.next();
}}});
const appProbe = extension({label: "proof.app", hooks: {start(event) {
  if (mode === "app-start") throw new Error("proof.app-start");
  event.defer(() => { if (mode === "close-failure") throw new Error("proof.close"); });
  return event.next();
}}});
const stop =`,
      )
      .replace("extensions: [telemetryExport]", "extensions: [toolsProbe, telemetryExport]")
      .replace("extensions: [startRequests", "extensions: [appProbe, startRequests")
      .replace(
        "let close = once(",
        'void tools.closed.then(() => console.log("tools.closed"));\nlet close = once(',
      )
      .replace(
        "  close = once(",
        '  void app.closed.then(() => console.log("app.closed"));\n  close = once(',
      )
      .replace(
        "process.env.SMTP_FROM !== undefined && mail.mailFrom(process.env.SMTP_FROM)",
        'mode !== "missing-tag" && process.env.SMTP_FROM !== undefined && mail.mailFrom(process.env.SMTP_FROM)',
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
        ["tools-start", "bad-log-level"].includes(mode) ? 0 : 1,
        log,
      );
      if (!["tools-start", "bad-log-level"].includes(mode)) {
        assert.ok(lines.indexOf("app.closed") < lines.indexOf("tools.closed"), log);
      }

      if (["tools-start", "app-start", "missing-tag", "bad-log-level"].includes(mode)) {
        assert.ok(lines.includes(mode + ": original failure reported"), log);
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
