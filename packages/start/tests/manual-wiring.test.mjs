import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createScope } from "@tinker/core";
import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";

import { named } from "../lib/checks/named.mjs";
import { aliases } from "../lib/glue.mjs";
import { baseDir } from "../lib/paths.mjs";
import { prepare } from "../lib/prepare.mjs";
import { fixture } from "./fixture.mjs";

const entry = readFileSync(join(baseDir, "tests/fixtures/server.ts"), "utf8");

test("prepare writes glue only and leaves component graph checks to doctor", () => {
  const root = fixture({
    "package.json": "{}",
    ...Object.fromEntries(
      ["component.json", "errors.ts", "index.ts"].map((file) => [
        `tinker/components/errors/${file}`,
        readFileSync(
          join(baseDir, "../../apps/start-scaffold/tinker/components/errors", file),
          "utf8",
        ),
      ]),
    ),
    ...Object.fromEntries(
      ["requests", "health", "http", "database", "telemetry"].flatMap((component) =>
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
    "cmds/server.ts": entry,
    ...Object.fromEntries(
      ["main.ts", "panics.server.ts", "server-entry.ts", "panics.tsx", "observe.ts"].map((file) => [
        `tinker/base/${file}`,
        readFileSync(join(baseDir, "../../apps/start-scaffold/tinker/base", file), "utf8"),
      ]),
    ),
    "tinker/components/mail/component.json": '{"requires":["missing"]}',
    "tinker/components/mail/index.server.ts": "export const recipient = 1;",
  });

  const files = prepare(root, []);

  expect(files).toEqual(["tsconfig.json"]);
  expect(named(root).lines).toEqual([
    "tinker/components/mail/component.json: requires missing component tinker/components/missing; shadcn add it",
  ]);
});

test("a copied component stays unconfigured until the app binds its required tags", async () => {
  const root = fixture({
    "package.json": '{"type":"module"}',
    ...Object.fromEntries(
      ["component.json", "errors.ts", "index.ts"].map((file) => [
        `tinker/components/errors/${file}`,
        readFileSync(
          join(baseDir, "../../apps/start-scaffold/tinker/components/errors", file),
          "utf8",
        ),
      ]),
    ),
    ...Object.fromEntries(
      ["requests", "health", "http", "database", "telemetry"].flatMap((component) =>
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
    "cmds/server.ts": entry,
    ...Object.fromEntries(
      ["main.ts", "panics.server.ts", "server-entry.ts", "panics.tsx", "observe.ts"].map((file) => [
        `tinker/base/${file}`,
        readFileSync(join(baseDir, "../../apps/start-scaffold/tinker/base", file), "utf8"),
      ]),
    ),
    "tinker/components/mail/component.json": '{"requires":["database"]}',
    "tinker/components/mail/index.server.ts": `import { tag, operation, extension } from "@tinker/core";
export const recipient = tag({ label: "mail.recipient" });
export const greet = operation({ depends: { recipient }, run: ({recipient}) => recipient });
export const mailStartup = extension({hooks:{start({resolve,next}){resolve(recipient);return next();}}});`,
  });

  symlinkSync(join(baseDir, "node_modules"), join(root, "node_modules"));
  prepare(root, []);

  const vite = await createServer({
    root,
    configFile: false,
    ssr: { noExternal: ["@tinker/start"] },
    resolve: {
      alias: [...aliases(root)],
    },
    server: { middlewareMode: true, watch: null },
  });
  const { mailStartup } = await vite.ssrLoadModule(
    join(root, "tinker/components/mail/index.server.ts"),
  );
  const ownScope = createScope({ extensions: [mailStartup] });
  try {
    await expect(ownScope.ready).rejects.toMatchObject({
      kind: "MissingTag",
      payload: { label: "mail.recipient" },
    });
  } finally {
    await ownScope.close({ graceful: true });
    await vite.close();
  }
}, 30000);
