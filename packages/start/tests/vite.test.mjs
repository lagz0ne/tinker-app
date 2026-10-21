import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { aliases, startOptions } from "../lib/glue.mjs";
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

/** An app with only cmds/cli.ts. */
function cliApp() {
  return fixture({
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({ cliEntry: "cmds/cli.ts" })] };\n',
    "cmds/cli.ts": "export default 1;\n",
  });
}

test("a CLI-only app gets only the glue plugin, after prepare", () => {
  const root = cliApp();

  const plugins = tinker({ root, cliEntry: "cmds/cli.ts" });

  expect(existsSync(join(root, ".tinker/tsconfig.json"))).toBe(true);
  expect(plugins).toEqual([{ name: "tinker:glue", enforce: "pre", config: expect.any(Function) }]);
  expect(plugins[0].config()).toMatchObject({
    resolve: { alias: aliases(root) },
    tsconfig: join(root, ".tinker/tsconfig.json"),
  });
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
});
