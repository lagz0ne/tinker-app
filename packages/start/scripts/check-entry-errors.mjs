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
if (process.env.PANIC_MODE === "startup") {
  await assert.rejects(import("./dist/server/server.js"), {message: "proof.startup"});
  console.log("startup: original failure reported");
  process.exitCode = 1;
} else {
  const built = await import("./dist/server/server.js");
  const response = await built.default.fetch(new Request("http://localhost/proof/" + process.env.PANIC_MODE));
  if (process.env.PANIC_MODE === "rejection") {
    assert.equal(response.status, 200);
    setInterval(() => {}, 1000);
  } else {
    assert.equal(response.status, 500);
    const health = await built.default.fetch(new Request("http://localhost/api/health"));
    assert.equal(health.status, 200);
    console.log("handler: 500; next request: 200");
    await built.close();
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
    const main = readFileSync(entry, "utf8")
      .replace("import { createScope }", "import { createScope, extension }")
      .replace(
        "const values =",
        'const mode = process.env.PANIC_MODE;\nconst probe = extension({ label: "proof.panic", hooks: { start(event) { if (mode === "startup") throw new Error("proof.startup"); return event.next(); } } });\nconst values =',
      )
      .replace("start.auth.extensions]", "start.auth.extensions, probe]")
      .replace(
        "await tools.ready;",
        'await tools.ready;\ntools.onClose(() => { console.log("tools.closed"); });',
      )
      .replace(
        "await app.ready.catch(close);",
        'app.onClose(() => { console.log("app.closed"); });\nawait app.ready.catch(close);',
      );
    writeFileSync(entry, main);
    mkdirSync(join(fixture, "src/routes/proof"), { recursive: true });
    writeFileSync(
      join(fixture, "src/routes/proof/handler.ts"),
      `
import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "@tinker/start/server";
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
  GET: () => { Promise.reject(new Error("proof.unhandled")); return new Response("sent"); },
}}});
`,
    );
    const build = spawnSync("vp", ["build"], { cwd: fixture, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);

    for (const mode of ["startup", "handler", "rejection"]) {
      const ran = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
        cwd: fixture,
        env: { ...process.env, NODE_ENV: "production", PANIC_MODE: mode },
        encoding: "utf8",
        timeout: 15000,
      });

      const log = `${ran.stdout}${ran.stderr}`;
      assert.equal(ran.status, mode === "handler" ? 0 : 1, log);
      assert.ok(ran.stdout.split("\n").includes("app.closed"), `${mode}: app must close\n${log}`);
      assert.ok(
        ran.stdout.split("\n").includes("tools.closed"),
        `${mode}: tools must close\n${log}`,
      );
      if (mode === "startup") {
        assert.ok(ran.stdout.split("\n").includes("startup: original failure reported"), log);
      }
      if (mode === "handler") {
        assert.ok(ran.stdout.split("\n").includes("handler: 500; next request: 200"), log);
        assert.ok(ran.stdout.split("\n").includes("request.closed"), log);
      }
      if (mode === "rejection") {
        assert.ok(
          ran.stderr.split("\n").includes("server: unhandled rejection Error: proof.unhandled"),
          log,
        );
      }
      console.log(`${app}: ${mode}; both roots closed; EXIT ${ran.status}`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
