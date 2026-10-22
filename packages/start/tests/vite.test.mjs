import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { aliases, startOptions } from "../lib/glue.mjs";
import { say as typeSay } from "../lib/typecheck.mjs";
import { tinker } from "../vite.mjs";
import { fixture, goodApp } from "./fixture.mjs";

/** What tinker() passed to the web plugins, so a test can read it without loading them. */
const calls = vi.hoisted(() => ({ start: [], react: 0 }));

vi.mock("@tanstack/react-start/plugin/vite", () => ({
  tanstackStart: (options) => {
    calls.start.push(options);
    return { name: "fake-start" };
  },
}));

vi.mock("@vitejs/plugin-react", () => ({
  default: () => {
    calls.react += 1;
    return { name: "fake-react" };
  },
}));

/**
 * An app with only cmds/cli.ts, built the way vite.cli.config.ts names.
 * @param {string} [cli] - From a test; why: the CLI entry's source.
 * @param {Record<string, string>} [files] - From a test; why: files that replace the defaults.
 */
function cliApp(cli = "export default 1;\n", files = {}) {
  return fixture({
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({ cliEntry: "cmds/cli.ts" })] };\n',
    "vite.cli.config.ts": 'export default { build: { ssr: "cmds/cli.ts", outDir: "dist-cli" } };\n',
    "cmds/cli.ts": cli,
    ...files,
  });
}

test("a CLI-only app gets the glue, which builds cmds/cli.ts, and the build checks", () => {
  const root = cliApp();

  const plugins = tinker({ root, cliEntry: "cmds/cli.ts" });

  expect(existsSync(join(root, ".tinker/tsconfig.json"))).toBe(true);
  expect(plugins.map(({ name }) => name)).toEqual(["tinker:glue", "tinker:verify"]);
  expect(plugins[0].enforce).toBe("pre");
  expect(plugins[0].config()).toMatchObject({
    resolve: { alias: aliases(root) },
    tsconfig: join(root, ".tinker/tsconfig.json"),
    build: { ssr: "cmds/cli.ts", outDir: "dist-cli" },
    ssr: { external: ["@tinker/start", "@tinker/core"] },
  });
});

test("a CLI-only app with a worker too still builds cmds/cli.ts with vp build", () => {
  const root = cliApp(undefined, {
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({ workerEntry: "cmds/worker.ts", cliEntry: "cmds/cli.ts" })] };\n',
    "vite.worker.config.ts":
      'export default { build: { ssr: "cmds/worker.ts", outDir: "dist-worker" } };\n',
    "cmds/worker.ts": "export default 1;\n",
  });

  const [glue] = tinker({ root, workerEntry: "cmds/worker.ts", cliEntry: "cmds/cli.ts" });

  expect(glue.config().build).toEqual({ ssr: "cmds/cli.ts", outDir: "dist-cli" });
});

test("a CLI-only build stops on its named check and on tsc, and keeps no Start record", () => {
  const [, good] = tinker({ root: cliApp(), cliEntry: "cmds/cli.ts" });
  const [, bad] = tinker({ root: cliApp("export const main = 1;\n"), cliEntry: "cmds/cli.ts" });
  const lines = [];
  const config = { logger: { warn: (line) => lines.push(`warn: ${line}`) } };

  good.configResolved.handler(config);
  good.buildStart.call({ error: (text) => lines.push(`error: ${text}`) });

  expect(() => bad.configResolved.handler(config)).toThrow(
    "tinker doctor, named files: cmds/cli.ts:1 does not export default",
  );
  expect(lines).toEqual([`error: ${typeSay.noTypescript}`]);
});

test("a web app passes its own and the passed options to TanStack Start, and loads React", async () => {
  const root = goodApp();
  const own = startOptions(root);
  const prerender = { enabled: false };
  calls.start.length = 0;
  calls.react = 0;

  const [glue, start] = tinker({ root, prerender });
  const vitest = process.env.VITEST;
  delete process.env.VITEST;
  const full = tinker({ root });
  process.env.VITEST = vitest;

  expect(glue.name).toBe("tinker:glue");
  expect(await start).toEqual({ name: "fake-start" });
  expect(calls.start[0]).toEqual({
    ...own,
    prerender,
    importProtection: { ...own.importProtection, onViolation: expect.any(Function) },
  });
  expect(await full[4]).toEqual({ name: "fake-react" });
  expect(calls.react).toBe(1);

  full[1].buildStart.call({ error: () => {} });
  expect(readFileSync(join(root, ".tinker/violations.json"), "utf8")).toBe("[]\n");
});
