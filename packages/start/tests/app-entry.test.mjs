import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createScope, extension } from "@tinker/core";
import { createServer } from "vite-plus";
import { expect, onTestFinished, test } from "vite-plus/test";

import { named } from "../lib/checks/named.mjs";
import { doctor } from "../lib/doctor.mjs";
import { aliases } from "../lib/glue.mjs";
import { baseDir } from "../lib/paths.mjs";
import { prepare } from "../lib/prepare.mjs";
import * as serverApi from "../src/server";
import { fixture, goodApp } from "./fixture.mjs";

const source = readFileSync(join(baseDir, "tests/fixtures/server.ts"), "utf8");
const missing = `src/server.ts is missing; add this server entry:\n${source}`;

test("doctor names a missing app server entry and shows its starter code", () => {
  const root = goodApp();
  rmSync(join(root, "src/server.ts"), { force: true });

  const checked = named(root);
  const printed = doctor(root, false);

  expect(checked.status).toBe("fail");
  expect(checked.lines).toEqual([missing]);
  expect(printed.code).toBe(1);
  expect(printed.lines).toContain(
    missing
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n"),
  );
});

test("prepare refuses a missing app server entry with the same starter code", () => {
  const root = goodApp();
  rmSync(join(root, "src/server.ts"), { force: true });

  const ran = spawnSync(process.execPath, [join(baseDir, "bin/tinker.mjs"), "prepare"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_lifecycle_event: "" },
  });

  expect(ran.status).toBe(1);
  expect(ran.stdout).toBe(missing + "\n");
});

/** A real app file with one replaceable wiring import; no framework build is needed. */
async function loadEntry(wiring) {
  const root = fixture({
    "package.json": '{"type":"module"}',
    "src/server.ts": source.replace('"@tinker/start/wiring"', '"@/wiring.server"'),
    "src/wiring.server.ts": wiring,
  });
  symlinkSync(join(baseDir, "../../apps/start-min/node_modules"), join(root, "node_modules"));
  prepare(root, []);

  const vite = await createServer({
    root,
    configFile: false,
    ssr: { noExternal: ["@tinker/start"] },
    resolve: { alias: aliases(root) },
    server: { middlewareMode: true, watch: null },
  });
  onTestFinished(() => vite.close());
  return { vite, root };
}

const wiring = `import { extension } from "@tinker/core";
export const events = [];
export const extensions = [extension({ label: "proof.start", hooks: {
  async start(event) {
    await event.next();
    events.push("app.ready");
    event.defer(() => { events.push("app.closed"); });
  },
} })];
export const settings = () => [];
`;

test("the app file starts before any request, reuses its roots, and closes once", async () => {
  const { vite, root } = await loadEntry(wiring);
  const proof = await vite.ssrLoadModule(join(root, "src/wiring.server.ts"));

  const { default: server } = await vite.ssrLoadModule(join(root, "src/server.ts"));
  const again = await vite.ssrLoadModule(join(root, "src/server.ts"));
  expect(proof.events).toEqual(["app.ready"]);
  expect(again.default.requestContext.scope).toBe(server.requestContext.scope);
  const closing = server.close();
  expect(server.close()).toBe(closing);
  await closing;

  expect(proof.events).toEqual(["app.ready", "app.closed"]);
  await expect(server.requestContext.scope.closed).resolves.toMatchObject({ status: "success" });
});

test("the app entry reports a teardown error after closing its roots", async () => {
  const { vite, root } = await loadEntry(
    wiring.replace('events.push("app.closed");', 'events.push("app.closed"); throw failure;') +
      'export const failure = { kind: "proof.teardown" };\n',
  );
  const proof = await vite.ssrLoadModule(join(root, "src/wiring.server.ts"));
  const { default: server } = await vite.ssrLoadModule(join(root, "src/server.ts"));

  const closing = server.close();
  await expect(closing).rejects.toBe(proof.failure);

  expect(server.close()).toBe(closing);
  expect(proof.events).toEqual(["app.ready", "app.closed"]);
});

test("an app startup failure closes the entry's roots and keeps the original error", async () => {
  const { vite, root } = await loadEntry(
    wiring.replace('events.push("app.ready");', "throw failure;") +
      'export const failure = { kind: "proof.startup" };\n',
  );
  const proof = await vite.ssrLoadModule(join(root, "src/wiring.server.ts"));

  const started = vite.ssrLoadModule(join(root, "src/server.ts"));

  await expect(started).rejects.toBe(proof.failure);
});

test("close ends every root in reverse order before reporting a teardown error", async () => {
  const events = [];
  const failure = { kind: "proof.teardown" };
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: [
      extension({
        hooks: {
          start(event) {
            event.defer(() => {
              events.push("tools");
            });
            return event.next();
          },
        },
      }),
    ],
  });
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    extensions: [
      extension({
        hooks: {
          start(event) {
            event.defer(() => {
              events.push("app");
              throw failure;
            });
            return event.next();
          },
        },
      }),
    ],
  });
  await tools.ready;
  await app.ready;
  const close = serverApi.createScopeClose([
    { scope: tools, stop: toolStop },
    { scope: app, stop },
  ]);

  const ended = close();
  await expect(ended).rejects.toBe(failure);

  expect(events).toEqual(["app", "tools"]);
  expect(close()).toBe(ended);
});
