import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createScope, extension } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { named } from "../lib/checks/named.mjs";
import { doctor } from "../lib/doctor.mjs";
import { baseDir } from "../lib/paths.mjs";
import { parseSource } from "../lib/source.mjs";
import { goodApp } from "./fixture.mjs";

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
  const reason = new DOMException("The server closed", "AbortError");
  const closed = app.closed.then(async (appEnd) => {
    toolStop.abort(reason);
    const toolsEnd = await tools.closed;
    for (const result of [appEnd, toolsEnd]) {
      if (result.status === "failed") throw result.error;
      if (result.teardownErrors?.length) throw result.teardownErrors[0];
    }
  });

  stop.abort(reason);
  await expect(closed).rejects.toBe(failure);

  expect(events).toEqual(["app", "tools"]);
  stop.abort(reason);
  expect(events).toEqual(["app", "tools"]);
  expect(() => stop.signal.throwIfAborted()).toThrow(
    expect.objectContaining({ name: "AbortError", message: "The server closed" }),
  );
  expect(toolStop.signal.reason).toBe(stop.signal.reason);
});

for (const app of ["start-scaffold", "start-min"]) {
  test(`${app}: the server module only exports its main function`, () => {
    const file = join(baseDir, "../../apps", app, "cmds/server.ts");
    const { program } = parseSource(file);
    const body = program.body.filter((node) => node.type !== "ImportDeclaration");

    expect(body.map((node) => node.type)).toEqual(["ExportDefaultDeclaration"]);
    expect(body[0].declaration).toMatchObject({
      type: "CallExpression",
      callee: { type: "Identifier", name: "defineMain" },
      arguments: [{ type: "ArrowFunctionExpression", async: true }],
    });
    expect(readFileSync(file, "utf8")).not.toContain("import.meta.hot");
    expect(
      body[0].declaration.arguments[0].params[0].properties.map((property) => property.key.name),
    ).toEqual(["env", "args", "signal", "stdout", "stderr", "exit"]);
    expect(readFileSync(file, "utf8")).not.toMatch(/process\.|loadEnvFile|\bonce\s*\(/);
  });
}
