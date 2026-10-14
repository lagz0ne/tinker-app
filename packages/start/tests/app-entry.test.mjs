import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createScope, extension } from "@tinker/core";
import { createServer } from "vite-plus";
import { expect, onTestFinished, test } from "vite-plus/test";

import { createScopeClose } from "~/base/close";

import { named } from "../lib/checks/named.mjs";
import { doctor } from "../lib/doctor.mjs";
import { aliases } from "../lib/glue.mjs";
import { baseDir } from "../lib/paths.mjs";
import { prepare } from "../lib/prepare.mjs";
import { fixture, goodApp } from "./fixture.mjs";

const source = readFileSync(join(baseDir, "tests/fixtures/server.ts"), "utf8");
const missing = `cmds/server.ts is missing; add this server entry:\n${source}`;

test("doctor names a missing app server entry and shows its starter code", () => {
  const root = goodApp();
  rmSync(join(root, "cmds/server.ts"), { force: true });

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

test.each(["", "postinstall"])(
  "prepare refuses a missing app server entry with the same starter code (%s)",
  (lifecycle) => {
    const root = goodApp();
    rmSync(join(root, "cmds/server.ts"), { force: true });

    const ran = spawnSync(process.execPath, [join(baseDir, "bin/tinker.mjs"), "prepare"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_lifecycle_event: lifecycle },
    });

    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe(missing + "\n");
  },
);

/** A real app file with one replaceable wiring import; no framework build is needed. */
async function loadEntry(wiring, entry = source) {
  const root = fixture({
    "package.json": '{"type":"module"}',
    ...Object.fromEntries(
      ["close.ts", "panics.server.ts", "server-entry.ts", "panics.tsx", "observe.ts"].map(
        (file) => [
          `tinker/base/${file}`,
          readFileSync(join(baseDir, "../../apps/start-scaffold/tinker/base", file), "utf8"),
        ],
      ),
    ),
    ...Object.fromEntries(
      ["component.json", "errors.ts", "env.ts", "index.ts"].map((file) => [
        `tinker/components/errors/${file}`,
        readFileSync(
          join(baseDir, "../../apps/start-scaffold/tinker/components/errors", file),
          "utf8",
        ),
      ]),
    ),
    ...Object.fromEntries(
      ["requests", "health"].flatMap((component) =>
        readdirSync(join(baseDir, "../../apps/start-scaffold/tinker/components", component)).map(
          (file) => [
            `tinker/components/${component}/${file}`,
            readFileSync(
              join(baseDir, "../../apps/start-scaffold/tinker/components", component, file),
              "utf8",
            ),
          ],
        ),
      ),
    ),
    "cmds/server.ts": entry
      .replace(
        'import * as start from "@tinker/start/server";',
        'import * as start from "@tinker/start/server";\nimport { extensions, settings } from "~/components/proof/index.server";',
      )
      .replace(
        "const appTags = [start.auth.settings(values)];",
        "const appTags = [start.auth.settings(values), settings(values)];",
      )
      .replace("start.auth.extensions]", "start.auth.extensions, extensions]"),
    "tinker/components/proof/component.json": '{"requires":[]}',
    "tinker/components/proof/index.server.ts": wiring,
  });
  symlinkSync(join(baseDir, "node_modules"), join(root, "node_modules"));
  prepare(root, []);

  const vite = await createServer({
    root,
    configFile: false,
    ssr: { noExternal: ["@tinker/start"] },
    resolve: {
      alias: [
        { find: "@tinker/start/server", replacement: join(baseDir, "src/server.ts") },
        { find: /^@tinker\/start$/, replacement: join(baseDir, "src/index.ts") },
        ...aliases(root),
      ],
    },
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
  const proof = await vite.ssrLoadModule(join(root, "tinker/components/proof/index.server.ts"));

  const { default: server } = await vite.ssrLoadModule(join(root, "cmds/server.ts"));
  const again = await vite.ssrLoadModule(join(root, "cmds/server.ts"));
  expect(proof.events).toEqual(["app.ready"]);
  expect(again.default.requestContext.scope).toBe(server.requestContext.scope);
  const closing = server.close();
  expect(server.close()).toBe(closing);
  await closing;

  expect(proof.events).toEqual(["app.ready", "app.closed"]);
  await expect(server.requestContext.scope.closed).resolves.toMatchObject({ status: "success" });
}, 30000);

test("the app entry reports a teardown error after closing its roots", async () => {
  const { vite, root } = await loadEntry(
    wiring.replace('events.push("app.closed");', 'events.push("app.closed"); throw failure;') +
      'export const failure = { kind: "proof.teardown" };\n',
  );
  const proof = await vite.ssrLoadModule(join(root, "tinker/components/proof/index.server.ts"));
  const { default: server } = await vite.ssrLoadModule(join(root, "cmds/server.ts"));

  const closing = server.close();
  await expect(closing).rejects.toBe(proof.failure);

  expect(server.close()).toBe(closing);
  expect(proof.events).toEqual(["app.ready", "app.closed"]);
}, 30000);

test("an app startup failure closes the entry's roots and keeps the original error", async () => {
  const { vite, root } = await loadEntry(
    wiring.replace('events.push("app.ready");', "throw failure;") +
      'export const failure = { kind: "proof.startup" };\nexport const toolsClosed = [];\n',
    source
      .replace(
        'import * as start from "@tinker/start/server";',
        'import * as start from "@tinker/start/server";\nimport { toolsClosed } from "~/components/proof/index.server";',
      )
      .replace("await tools.ready;", "await tools.ready;\ntoolsClosed.push(tools.closed);"),
  );
  const proof = await vite.ssrLoadModule(join(root, "tinker/components/proof/index.server.ts"));

  const started = vite.ssrLoadModule(join(root, "cmds/server.ts"));

  await expect(started).rejects.toBe(proof.failure);
  expect(proof.toolsClosed).toHaveLength(1);
  await expect(proof.toolsClosed[0]).resolves.toMatchObject({ status: "success" });
}, 30000);

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
  const close = createScopeClose({ tools, app }, { tools: toolStop, app: stop });

  const ended = close();
  await expect(ended).rejects.toBe(failure);

  expect(events).toEqual(["app", "tools"]);
  expect(close()).toBe(ended);
  expect(() => stop.signal.throwIfAborted()).toThrow(
    expect.objectContaining({ name: "AbortError", message: "The server closed" }),
  );
  expect(toolStop.signal.reason).toBe(stop.signal.reason);
});
