import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { rules } from "@/operations/rules";
import { appDir, childEnv, print, warn } from "@/tags";

import { start, tempFolder } from "./temp";

const text =
  "# Rules\n\n### B: own the boundary\n\n- `B1` One,\n  two.\n- `B2` Two.\n\n### C: close\n\n- `C1` Close.\n";

/**
 * Run the rules operation for an app, and keep what it printed and warned.
 * @param app - From a test; why: the app whose Start to read.
 * @param ids - From a test; why: the IDs asked for.
 */
async function run(app: string, ids: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const tags = [
    appDir(app),
    childEnv({ PATH: process.env.PATH }),
    print((line) => out.push(line)),
    warn((line) => err.push(line)),
  ];
  const scope = createScope({ tags });
  try {
    return { outcome: scope.run(rules, { input: { ids } }), out, err };
  } catch (error) {
    return { outcome: error, out, err };
  } finally {
    await scope.close();
  }
}

test("rules prints the app's Start version and path, then every rule under its group", async () => {
  const app = tempFolder();
  const folder = start(app, "1.2.3", text);

  expect(await run(app, [])).toEqual({
    outcome: "done",
    out: [
      `@tinker/start 1.2.3: ${folder}/docs/rules.md`,
      "",
      "### B: own the boundary",
      "",
      "- `B1` One,",
      "  two.",
      "- `B2` Two.",
      "",
      "### C: close",
      "",
      "- `C1` Close.",
    ],
    err: [],
  });
});

test("rules with IDs prints only those, in the asked order, once each, in any case", async () => {
  const app = tempFolder();
  start(app, "1.2.3", text);

  const { outcome, out } = await run(app, ["c1", "B1", "b1"]);

  expect(outcome).toBe("done");
  expect(out.slice(1)).toEqual(["", "- `C1` Close.", "", "- `B1` One,", "  two."]);
});

test("unknown IDs are refused on warn, with every known ID", async () => {
  const app = tempFolder();
  start(app, "1.2.3", text);

  expect(await run(app, ["B1", "Z9", "Y8"])).toEqual({
    outcome: "refused",
    out: [],
    err: ["tinker-loop: unknown rule Z9, Y8; known rules: B1, B2, C1"],
  });
});

test("with no Start, the operation fails with the startRules message", async () => {
  const app = tempFolder();

  const { outcome, out } = await run(app, []);

  expect(String(outcome)).toContain(
    `cannot find @tinker/start from ${app}; install it to read its rules`,
  );
  expect(out).toEqual([]);
});
