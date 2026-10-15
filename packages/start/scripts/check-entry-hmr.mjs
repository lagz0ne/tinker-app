import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { createServer } from "vite-plus";

import { appFiles, serverFile } from "../lib/named.mjs";

// Auth and backend settings come from the caller's test env, as in the real app entry.
const app = resolve(process.argv[2]);
const fixture = mkdtempSync(join(tmpdir(), "start-entry-hmr-"));
let vite;
const entries = [];

try {
  cpSync(app, fixture, {
    recursive: true,
    filter: (file) => !["node_modules", "dist", ".tinker", ".tanstack"].includes(basename(file)),
  });
  symlinkSync(join(app, "node_modules"), join(fixture, "node_modules"), "dir");
  const entry = join(fixture, serverFile(fixture).file);
  const original = readFileSync(entry, "utf8");
  assert.ok(
    original.includes("tools.resolve(renderObserve, { ns: renderNs })"),
    "plant must replace the command's render observer",
  );
  const source = `const probe = { renderSpans: [] }; globalThis.__entryProof = probe;\n${original
    .replaceAll(
      "tools.resolve(renderObserve, { ns: renderNs })",
      "{ export: (span) => probe.renderSpans.push(span) }",
    )
    .replace("let close = once(", "probe.toolsClosed = tools.closed;\nlet close = once(")
    .replace("  close = once(", "  probe.appClosed = app.closed;\n  close = once(")}`;
  const routerFile = join(
    fixture,
    appFiles(fixture).find((file) => file.option === "routerEntry").file,
  );
  const routerSource = readFileSync(routerFile, "utf8");
  assert.ok(routerSource.includes("const extensions: [] = [];"));
  writeFileSync(
    routerFile,
    `import { extension, operation } from "@tinker/core";\n${routerSource.replace(
      "const extensions: [] = [];",
      `
const probe = operation({ label: "render-probe", run: () => 1 });
const extensions = [extension({
  hooks: { async start({ next, scope }) { await next(); scope.run(probe); } },
})];`,
    )}`,
  );
  const version = (value) =>
    source.replace(
      "{ requestContext: app.resolve(startRequests), close }",
      `{ requestContext: app.resolve(startRequests), close, fetch(request, next) { return new URL(request.url).pathname === "/scope-proof" ? new Response("${value}") : next(request); } }`,
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
  const firstProof = globalThis.__entryProof;
  entries.push(first);
  assert.equal((await vite.environments.ssr.runner.import(entry)).default, first);
  const rendered = await fetch(new URL("/", address));
  assert.equal(rendered.status, 200);
  await rendered.text();
  assert.ok(firstProof.renderSpans.length > 0, "the first render must use the first observer");

  writeFileSync(entry, version("second"));
  let timeout;
  const closing = Promise.race([
    Promise.all([firstProof.appClosed, firstProof.toolsClosed]),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("HMR did not close both old roots")), 20000);
    }),
  ]);
  const [closed, toolsClosed] = await closing.finally(() => clearTimeout(timeout));
  assert.equal(closed.status, "success");
  assert.equal(toolsClosed.status, "success");

  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    response = await (await fetch(address)).text();
    if (response === "second") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(response, "second");
  const secondModule = await vite.environments.ssr.runner.import(entry);
  const second = secondModule.default;
  const secondProof = globalThis.__entryProof;
  entries.push(second);
  assert.notEqual(second, first);
  const nextRendered = await fetch(new URL("/", address));
  assert.equal(nextRendered.status, 200);
  await nextRendered.text();
  assert.ok(secondProof.renderSpans.length > 0, "HMR renders must use the new observer");
  assert.equal((await fetch(new URL("/api/health", address))).status, 200);
  if (existsSync(join(fixture, "tinker/components/auth/component.json"))) {
    const auth = await fetch(new URL("/api/auth/get-session", address));
    assert.equal(auth.status, 200);
    assert.equal(await auth.json(), null);
  }
  await second.close();
  assert.equal((await secondProof.toolsClosed).status, "success");
  console.log(
    "HMR: unchanged entry reused; both old roots closed; new requests and renders use the new entry; EXIT 0",
  );
} finally {
  for (const entry of entries) await entry.close();
  await vite?.close();
  rmSync(fixture, { recursive: true, force: true });
}
