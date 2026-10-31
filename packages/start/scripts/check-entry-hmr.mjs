import assert from "node:assert/strict";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { appFiles, serverFile } from "../lib/named.mjs";

// Auth and backend settings come from the caller's test env, as in the real app entry.
const app = resolve(process.argv[2]);
const appVite = createRequire(join(app, "package.json")).resolve("vite");
const { createServer } = await import(pathToFileURL(appVite).href);
const fixture = mkdtempSync(join(tmpdir(), "start-entry-hmr-"));
let vite;
const entries = [];

try {
  cpSync(app, fixture, {
    recursive: true,
    filter: (file) =>
      !["node_modules", "dist", ".tinker", ".tanstack", ".stryker-tmp", "reports"].includes(
        basename(file),
      ),
  });
  symlinkSync(join(app, "node_modules"), join(fixture, "node_modules"), "dir");
  const entry = join(fixture, serverFile(fixture).file);
  const original = readFileSync(entry, "utf8");
  assert.ok(
    original.includes("tools.resolve(renderObserve, { ns: renderNs })"),
    "plant must replace the command's render observer",
  );
  const source = `const probe = { renderSpans: [], starts: 0 }; globalThis.__entryProof = probe;\n${original
    .replace("  const stop =", "  probe.starts++; probe.signal = signal; const stop =")
    .replaceAll(
      "tools.resolve(renderObserve, { ns: renderNs })",
      "{ export: (span) => probe.renderSpans.push(span) }",
    )
    .replace(
      "  await tools.ready;",
      "  probe.toolsClosed = tools.closed; probe.abort = () => stop.app.abort(abortReasons.closed);\n  await tools.ready;",
    )
    .replace(
      "    await app.ready;\n",
      "    probe.appClosed = app.closed;\n    probe.closed = closed;\n    await app.ready;\n",
    )}`;
  assert.ok(source.includes("probe.closed = closed;"), "plant must hold the command's closed");
  const routerFile = join(
    fixture,
    appFiles(fixture).find((file) => file.option === "routerEntry").file,
  );
  const routerSource = readFileSync(routerFile, "utf8");
  assert.ok(routerSource.includes("extensions: [routerScope"));
  writeFileSync(
    routerFile,
    `import { extension, operation } from "@tinker/core";
const probe = operation({ label: "render-probe", run: () => 1 });
const renderProbe = extension({
  hooks: { async start({ next, scope }) { await next(); scope.run(probe); } },
});
${routerSource.replace("extensions: [routerScope", "extensions: [routerScope, renderProbe")}`,
  );
  const version = (value) =>
    source.replace(
      "{ requestContext: app.resolve(startRequests) }",
      `{ requestContext: app.resolve(startRequests), fetch(request, next) { return new URL(request.url).pathname === "/scope-proof" ? new Response("${value}") : next(request); } }`,
    );
  writeFileSync(entry, version("first"));

  process.chdir(fixture);
  vite = await createServer({
    root: fixture,
    server: { port: 0, watch: { usePolling: true, interval: 50 } },
  });
  await vite.listen();
  let address = `http://127.0.0.1:${vite.httpServer.address().port}/scope-proof`;
  await vite.environments.ssr.runner.import(entry);
  assert.equal(globalThis.__entryProof.starts, 0, "dev import starts nothing");
  if (existsSync(join(fixture, "tinker/components/mail/component.json"))) {
    const from = process.env.SMTP_FROM;
    delete process.env.SMTP_FROM;
    try {
      const stopped = once(vite.httpServer, "close", { signal: AbortSignal.timeout(10000) });
      const refused = await fetch(address);
      assert.equal(refused.status, 503, "startup exit returns the stopped response");
      assert.ok((await refused.text()).includes("Command stopped"));
      await stopped;

      const failed = globalThis.__entryProof;
      const [appEnd, toolsEnd] = await Promise.all([failed.appClosed, failed.toolsClosed]);
      assert.equal(appEnd.status, "failed");
      assert.equal(toolsEnd.status, "success");
    } finally {
      if (from !== undefined) process.env.SMTP_FROM = from;
    }

    await vite.close();
    vite = await createServer({
      root: fixture,
      server: { port: 0, watch: { usePolling: true, interval: 50 } },
    });
    await vite.listen();
    address = `http://127.0.0.1:${vite.httpServer.address().port}/scope-proof`;
    const replies = await Promise.all([1, 2, 3].map(() => fetch(address)));
    for (const reply of replies) assert.equal(await reply.text(), "first");
    assert.equal(
      globalThis.__entryProof.starts,
      1,
      "restart starts one command for concurrent requests",
    );
    console.log(
      "PASS: dev import is idle; startup exit closes the server; restart shares one start for concurrent requests.",
    );
  } else {
    assert.equal(await (await fetch(address)).text(), "first");
    assert.equal(globalThis.__entryProof.starts, 1);
  }
  const firstModule = await vite.environments.ssr.runner.import(entry);
  const first = firstModule.default;
  const firstProof = globalThis.__entryProof;
  entries.push(firstProof);
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
  assert.equal(firstProof.signal.aborted, true, "HMR aborts the host signal");
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
  entries.push(secondProof);
  assert.notEqual(second, first);
  const nextRendered = await fetch(new URL("/", address));
  assert.equal(nextRendered.status, 200);
  await nextRendered.text();
  assert.ok(secondProof.renderSpans.length > 0, "HMR renders must use the new observer");
  const health = await fetch(new URL("/api/health", address));
  assert.equal(health.status, 200);
  await health.text();
  if (existsSync(join(fixture, "tinker/components/auth/component.json"))) {
    const auth = await fetch(new URL("/api/auth/get-session", address));
    assert.equal(auth.status, 200);
    assert.equal(await auth.json(), null);
  }
  secondProof.abort();
  await secondProof.closed;
  assert.equal((await secondProof.toolsClosed).status, "success");
  console.log(
    "HMR: unchanged entry reused; both old roots closed; new requests and renders use the new entry; EXIT 0",
  );
} finally {
  for (const entry of entries) {
    entry.abort();
    await entry.closed;
  }
  await vite?.close();
  console.log("HMR: native server and watchers closed.");
  rmSync(fixture, { recursive: true, force: true });
}
