import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { named } from "../lib/checks/named.mjs";
import { checkCommands } from "../lib/command-gate.mjs";
import { buildChecks } from "../lib/doctor.mjs";
import { commandFiles } from "../lib/named.mjs";
import { goodApp, write } from "./fixture.mjs";

function processApp(extra = {}) {
  const main =
    'export default async ({exit})=>{exit(64);return {closed:Promise.resolve(),fetch:()=>new Response("stopped",{status:503})};};';
  const root = goodApp({
    "package.json": '{"type":"module"}',
    "cmds/worker.ts": main,
    "cmds/cli.ts": main,
    "vite.worker.config.ts": 'export default {build:{ssr:"cmds/worker.ts",outDir:"dist-worker"}};',
    "vite.cli.config.ts": 'export default {build:{ssr:"cmds/cli.ts",outDir:"dist-cli"}};',
    "dist/server/server.js": main,
    "dist-worker/worker.js": main,
    "dist-cli/cli.js": main,
  });
  const config = readFileSync(join(root, "vite.config.ts"), "utf8");
  write(root, {
    "vite.config.ts": config.replace(
      'startEntry: "cmds/start.ts"',
      'startEntry: "cmds/start.ts", workerEntry:"cmds/worker.ts", cliEntry:"cmds/cli.ts"',
    ),
    ...extra,
  });
  return root;
}

test("doctor knows server, worker and CLI exports and their own SSR builds", () => {
  const root = processApp();
  expect(named(root).status).toBe("ok");
  expect(commandFiles(root).map(({ file, output }) => [file, output])).toEqual([
    ["cmds/server.ts", "dist/server/server.js"],
    ["cmds/worker.ts", "dist-worker/worker.js"],
    ["cmds/cli.ts", "dist-cli/cli.js"],
  ]);
});

for (const role of ["worker", "cli"]) {
  test(`doctor and build name a missing ${role} default export`, () => {
    const root = processApp({ [`cmds/${role}.ts`]: "export const unused = 1;" });
    const message = `cmds/${role}.ts:1 does not export default; the base imports it from this file`;
    expect(named(root).lines).toContain(message);
    expect(buildChecks(root).errors).toContain(`tinker doctor, named files: ${message}`);
  });
  test(`doctor catches a ${role} build pointed at the wrong command`, () => {
    expect(
      named(
        processApp({
          [`vite.${role}.config.ts`]:
            'export default {build:{ssr:"cmds/wrong.ts",outDir:"dist-worker"}};',
        }),
      ).lines,
    ).toContain(`vite.${role}.config.ts:1 build.ssr must name cmds/${role}.ts`);
  });
}

test("an unnamed conventional worker cannot silently escape the build checks", () => {
  const root = goodApp({ "cmds/worker.ts": "export default 1;" });
  expect(named(root).lines).toContain("vite.config.ts: name workerEntry in tinker()");
});

test("the command gate builds then runs each entry serially", () => {
  const order = [];
  checkCommands(processApp(), (command, args, options) => {
    order.push([command === "vp" ? "build" : "run", ...args]);
    return command === "vp"
      ? { status: 0 }
      : spawnSync(command, args, { ...options, stdio: "pipe" });
  });
  expect(order.map(([kind]) => kind)).toEqual(["build", "run", "build", "run", "build", "run"]);
  expect(order[2]).toEqual(["build", "build", "--config", "vite.worker.config.ts"]);
});

test("broken compiled worker fails the real child host check", () => {
  const root = processApp({
    "dist-worker/worker.js": "export default async()=>({closed:Promise.resolve()});",
  });
  expect(() =>
    checkCommands(root, (command, args, options) =>
      command === "vp" ? { status: 0 } : spawnSync(command, args, { ...options, stdio: "pipe" }),
    ),
  ).toThrow("cmds/worker.ts: host check failed");
});

test("a failed CLI build stops before its host check", () => {
  expect(() =>
    checkCommands(processApp(), (command, args, options) => {
      if (command === "vp") return { status: args.includes("vite.cli.config.ts") ? 1 : 0 };
      return spawnSync(command, args, { ...options, stdio: "pipe" });
    }),
  ).toThrow("cmds/cli.ts: build failed");
});
