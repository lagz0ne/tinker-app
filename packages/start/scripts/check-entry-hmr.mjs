import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite-plus";

import { serverFile } from "../lib/named.mjs";

const app = resolve(process.argv[2]);
const fixture = mkdtempSync(join(tmpdir(), "start-entry-hmr-"));
let vite;
const entries = [];
const routers = [];

try {
  cpSync(app, fixture, {
    recursive: true,
    filter: (file) => !["node_modules", "dist", ".tinker", ".tanstack"].includes(basename(file)),
  });
  symlinkSync(join(app, "node_modules"), join(fixture, "node_modules"), "dir");
  const entry = join(fixture, serverFile(fixture).file);
  const source = `export const renderSpans = [];\n${readFileSync(entry, "utf8").replace(
    "renderObserve: tools.resolve(start.telemetry.renderObserve, { ns: start.telemetry.renderNs })",
    "renderObserve: { export: (span) => renderSpans.push(span) }",
  )}`;
  writeFileSync(
    join(fixture, "cmds/router.ts"),
    `import { extension, operation } from "@tinker/core";
const probe = operation({ label: "render-probe", run: () => 1 });
export const router = () => ({});
export const extensions = [extension({
  hooks: { async start({ next, scope }) { await next(); scope.run(probe); } },
})];
`,
  );
  const version = (value) =>
    source.replace(
      "  close,",
      `  fetch(request, next) {\n    return new URL(request.url).pathname === "/scope-proof" ? new Response("${value}") : next(request);\n  },\n  close,`,
    );
  writeFileSync(entry, version("first"));

  process.chdir(fixture);
  vite = await createServer({
    root: fixture,
    server: { port: 0, watch: { usePolling: true, interval: 50 } },
  });
  await vite.listen();
  const address = `http://127.0.0.1:${vite.httpServer.address().port}/scope-proof`;
  assert.equal(await (await fetch(address)).text(), "first");
  const firstModule = await vite.environments.ssr.runner.import(entry);
  const first = firstModule.default;
  entries.push(first);
  assert.equal((await vite.environments.ssr.runner.import(entry)).default, first);
  const routerEntry = await vite.environments.ssr.runner.import(
    fileURLToPath(new URL("../src/entry/router.tsx", import.meta.url)),
  );
  routers.push(await routerEntry.getRouter());
  assert.ok(firstModule.renderSpans.length > 0, "the first render must use the first observer");

  writeFileSync(entry, version("second"));
  const closed = await Promise.race([
    first.requestContext.scope.closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("HMR did not close the old app root")), 20000),
    ),
  ]);
  assert.equal(closed.status, "success");
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    response = await (await fetch(address)).text();
    if (response === "second") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(response, "second");
  const secondModule = await vite.environments.ssr.runner.import(entry);
  const second = secondModule.default;
  entries.push(second);
  assert.notEqual(second.requestContext.scope, first.requestContext.scope);
  routers.push(await routerEntry.getRouter());
  assert.ok(secondModule.renderSpans.length > 0, "HMR renders must use the new observer");
  await second.close();
  console.log(
    "HMR: unchanged entry reused; old root closed; new requests and renders use the new entry; EXIT 0",
  );
} finally {
  for (const router of routers) await router.close();
  for (const entry of entries) await entry.close();
  await vite?.close();
  rmSync(fixture, { recursive: true, force: true });
}
