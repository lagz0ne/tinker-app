import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";

import { named } from "../lib/checks/named.mjs";
import { aliases } from "../lib/glue.mjs";
import { baseDir } from "../lib/paths.mjs";
import { prepare } from "../lib/prepare.mjs";
import { fixture } from "./fixture.mjs";

const entry = readFileSync(join(baseDir, "tests/fixtures/server.ts"), "utf8");

test("prepare writes glue only and leaves item graph checks to doctor", () => {
  const root = fixture({
    "package.json": "{}",
    "cmds/server.ts": entry,
    "tinker/components/mail/component.json": '{"requires":["missing"]}',
    "tinker/components/mail/index.server.ts": "export const settings = () => [];",
  });

  const files = prepare(root, []);

  expect(files).toEqual([
    "tsconfig.json",
    "base.json",
    "parts.ts",
    "parts.server.ts",
    "telemetry-env.ts",
  ]);
  expect(named(root).lines).toEqual([
    "tinker/components/mail/component.json: requires missing component tinker/components/missing; shadcn add it",
  ]);
});

test("an item role file cannot supply a missing export in the user's entry", () => {
  const root = fixture({
    "package.json": "{}",
    "cmds/server.ts": entry,
    ".tinker/base.json": '{"parts":["auth"]}',
    "tinker/components/auth/component.json": '{"requires":[]}',
    "tinker/components/auth/auth.server.ts": "export default 1;",
    "tinker/components/auth/readAccount.server.ts": "export default 2;",
  });

  const checked = named(root);

  expect(checked.lines).toEqual([
    "cmds/server.ts:1 does not export auth; the auth part reads it",
    "cmds/server.ts:1 does not export readAccount; the auth part reads it",
  ]);
});

test("an item settings file is not bound unless the user calls its public API", async () => {
  const root = fixture({
    "package.json": '{"type":"module"}',
    "cmds/server.ts": entry,
    "tinker/components/mail/component.json": '{"requires":[]}',
    "tinker/components/mail/index.server.ts": `import { tag, operation } from "@tinker/core";
export const recipient = tag({ label: "mail.recipient" });
export const greet = operation({ depends: { recipient }, run: ({recipient}) => recipient });`,
    "tinker/components/mail/settings.server.ts": `import { recipient } from "./index.server";
export default () => [recipient("Ada")];`,
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
  const { default: server } = await vite.ssrLoadModule(join(root, "cmds/server.ts"));

  try {
    const { greet } = await vite.ssrLoadModule(
      join(root, "tinker/components/mail/index.server.ts"),
    );
    const result = server.requestContext.scope.settle(greet);

    expect(result).toMatchObject({
      status: "failed",
      error: { kind: "MissingTag", payload: { label: "mail.recipient" } },
    });
  } finally {
    await server.close();
    await vite.close();
  }
}, 30000);
