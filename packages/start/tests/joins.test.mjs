import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test } from "vite-plus/test";

import { doctor } from "../lib/doctor.mjs";
import { aliases } from "../lib/glue.mjs";
import { restartNote } from "../lib/hooks.mjs";
import { baseDir, basePackage, findPackage } from "../lib/paths.mjs";
import { prepare, render } from "../lib/prepare.mjs";
import { checkTypes } from "../lib/typecheck.mjs";
import { fixture, goodApp, write } from "./fixture.mjs";

test("prepare uses numeric item order, then the user's seam, without reading role bodies", () => {
  const own = "export const extensions = [];\nexport const settings = () => [];\n";
  const root = goodApp({
    "src/lib/tinker.server.ts": own,
    "src/items/20-mail/extensions.server.ts": "export default [];\n",
    "src/items/20-mail/settings.server.ts": "export default () => [];\n",
    "src/items/3-postgres/database.server.ts": "not even parseable source",
    "src/items/3-postgres/settings.server.ts": "export default () => [];\n",
    "src/items/20-mail/extensions.ts": "export default [];\n",
    "src/items/helpers/database.ts": "export default 42;\n",
    "src/items/20-mail/other.server.ts": "export const database = 42;\n",
  });

  const files = render(root);
  prepare(root);

  const server = files["app.server.ts"];
  expect(server).toContain('from "@/items/3-postgres/database.server";');
  expect(server).toContain('from "@/items/20-mail/extensions.server";');
  expect(server.indexOf("3-postgres")).toBeLessThan(server.indexOf("20-mail"));
  expect(server).toContain("export const extensions = [item2Extensions, own.extensions] as const;");
  expect(server).toContain("  return [item0Settings(env), item3Settings(env), ownSettings(env)];");
  expect(server).toContain(" as database };");
  expect(server).not.toContain("other.server");
  expect(server).not.toContain("helpers/database");
  expect(readFileSync(join(root, "src/lib/tinker.server.ts"), "utf8")).toBe(own);
  expect(files["app.ts"]).not.toContain(".server");
  expect(JSON.parse(files["tsconfig.json"]).compilerOptions.paths["#tinker/app.server"]).toEqual([
    join(root, ".tinker/app.server.ts"),
  ]);
  expect(aliases(root).find(({ find }) => find.test("#tinker/app")).replacement).toBe(
    `${join(root, ".tinker/app.ts")}$1`,
  );
});

test("a 2fa helper folder cannot change numeric role order or full-name ties", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\n",
    "src/items/10-auth/extensions.server.ts": "export default [];\n",
    "src/items/10-auth/settings.server.ts": "export default () => [];\n",
    "src/items/2fa/helper.ts": "export const helper = 42;\n",
    "src/items/3-db/extensions.server.ts": "export default [];\n",
    "src/items/3-db/settings.server.ts": "export default () => [];\n",
    "src/items/3-mail/settings.server.ts": "export default () => [];\n",
  });

  const server = render(root)["app.server.ts"];

  expect(server.indexOf("3-db")).toBeLessThan(server.indexOf("3-mail"));
  expect(server.indexOf("3-mail")).toBeLessThan(server.indexOf("10-auth"));
  expect(server).not.toContain("2fa");
  expect(server).toContain(
    "export const extensions = [item0Extensions, item3Extensions, own.extensions] as const;",
  );
  expect(server).toContain(
    "  return [item1Settings(env), item2Settings(env), item4Settings(env), ownSettings(env)];",
  );
});

test("two item database files fail prepare and doctor once, even with a user owner", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
  });
  prepare(root);
  write(root, {
    ".tinker/routeTree.gen.ts": "import { Route } from './../src/routes/index'\n",
    "src/items/10-first/database.server.ts": "export default {};\n",
    "src/items/20-second/database.server.ts": "export default {};\n",
  });

  const prepareApp = () => prepare(root);
  const checked = doctor(root, false);

  const message =
    "database: src/items/10-first/database.server.ts and src/items/20-second/database.server.ts";
  expect(prepareApp).toThrow(message);
  expect(checked.code).toBe(1);
  expect(checked.lines.join("\n").replaceAll(/\s+/g, " ").split(message)).toHaveLength(2);
});

test("adding or removing role files restarts dev; other item files do not", () => {
  expect(restartNote("/app", "/app/src/items/10-mail/settings.server.ts", "added")).toBe(
    "tinker: src/items/10-mail/settings.server.ts added; restarting",
  );
  expect(restartNote("/app", "/app/src/items/10-mail/extensions.ts", "removed")).toBe(
    "tinker: src/items/10-mail/extensions.ts removed; restarting",
  );
  expect(restartNote("/app", "/app/src/items/10-mail/readme.ts", "added")).toBeNull();
  expect(restartNote("/app", "/app/src/items/10-mail/database.ts", "added")).toBeNull();
  expect(
    restartNote("/app", "/app/src/items/10-mail/nested/settings.server.ts", "added"),
  ).toBeNull();
});

test("the user's single names win over item roles", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
    "src/items/10-postgres/database.server.ts": "export default {};\n",
  });

  const server = render(root)["app.server.ts"];

  expect(server).toContain('export { database } from "@/lib/tinker.server";');
});

test("role folders require a numeric prefix; folders without roles are ignored", () => {
  const root = goodApp({
    "src/items/mail/settings.server.ts": "export default () => [];\n",
    "src/items/notes/helpers.ts": "export const helper = 42;\n",
  });

  const prepareApp = () => prepare(root);
  const checked = doctor(root, false);

  expect(prepareApp).toThrow("src/items/mail: role folders need a numeric prefix, such as 10-mail");
  expect(checked.code).toBe(1);
});

test("no item roles generates only the original seam re-export", () => {
  const root = goodApp({
    "src/items/helpers/helper.ts": "export default 42;\n",
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\n",
    "src/lib/tinker.ts": "export const extensions = [];\n",
  });

  const files = render(root);

  expect(files["app.server.ts"]).toBe('export * from "@/lib/tinker.server";\n');
  expect(files["app.ts"]).toBe('export * from "@/lib/tinker";\n');
});

const peers = [
  ...Object.keys(basePackage.tinker.tested),
  "typescript",
  "@types/node",
  "vite",
  "zod",
];

const typedFiles = {
  "package.json": "{}",
  "tsconfig.json": JSON.stringify({ extends: "./.tinker/tsconfig.json" }),
  "src/lib/tinker.server.ts": "export const extensions = [];\nexport const settings = () => [];\n",
  "src/lib/tinker.ts": "export const extensions = [];\n",
};

/** The app's real peers let tsc check generated roles without booting a framework. */
function typedApp(files) {
  const root = fixture({ ...typedFiles, ...files });
  for (const name of peers) {
    const target = findPackage(baseDir, name);
    mkdirSync(dirname(join(root, "node_modules", name)), { recursive: true });
    symlinkSync(target, join(root, "node_modules", name));
  }
  symlinkSync(baseDir, join(root, "node_modules/@tinker/start"));
  prepare(root);
  return root;
}

test("tsc rejects wrong settings bindings and a single name even with its part off", () => {
  const root = typedApp({
    "src/items/20-mail/settings.server.ts": "export default () => [42];\n",
    "src/items/10-postgres/database.server.ts": "export default 42;\n",
  });

  const errors = checkTypes(root).join("\n");

  expect(errors).toContain("TS2322");
  expect(errors).toContain("TS1360");
}, 20000);

test("tsc keeps tag values and the sync change union exact through the generated seam", () => {
  const root = typedApp({
    "src/items/20-mail/settings.server.ts":
      'import { tag } from "@tinker/core";\nconst smtpUrl = tag<URL>({ label: "mail.smtpUrl" });\nexport default () => [smtpUrl(new URL("smtp://mail"))];\n',
    "src/items/30-sync/readBatch.ts":
      'import { z } from "zod";\nexport default z.object({ version: z.number(), events: z.array(z.object({ stream: z.string(), revision: z.number(), executionId: z.string(), payload: z.object({ kind: z.literal("change"), change: z.object({ kind: z.literal("counter"), value: z.number() }) }) })) });\n',
    "src/check.ts":
      'import { readBatch } from "#tinker/app";\nexport const change: ReturnType<typeof readBatch.parse>["events"][number]["payload"]["change"] = { kind: "counter", value: 1 };\n',
  });

  const valid = checkTypes(root);

  expect(valid).toEqual([]);

  write(root, {
    "src/items/20-mail/settings.server.ts":
      'import { tag } from "@tinker/core";\nconst smtpUrl = tag<URL>({ label: "mail.smtpUrl" });\nexport default () => [smtpUrl("not-a-url")];\n',
    "src/check.ts":
      'import { readBatch } from "#tinker/app";\nexport const change: ReturnType<typeof readBatch.parse>["events"][number]["payload"]["change"] = { kind: "nope", value: 1 };\n',
  });

  const errors = checkTypes(root).join("\n");
  expect(errors).toContain("TS2345");
  expect(errors).toContain("TS2322");
}, 20000);

test("roles accept server operations and client resources", () => {
  const root = typedApp({
    "src/items/10-auth/readAccount.server.ts":
      'import { operation } from "@tinker/core";\nexport default operation({ label: "account", run: () => null });\n',
    "src/items/10-auth/bootstrap.server.ts":
      'import { operation } from "@tinker/core";\nexport default operation({ label: "bootstrap", run: () => ({ public: { stream: "public" as const, revision: 0 }, private: null }) });\n',
    "src/items/10-auth/auth.server.ts":
      'import { resource } from "@tinker/core";\nexport default resource({ label: "auth", factory: () => ({ handler: async () => new Response(), api: { getSession: async () => null } }) });\n',
    "src/items/30-sync/records.ts": `import { resource } from "@tinker/core";
import type { Sync } from "@tinker/start";
export default resource({ label: "records", factory: (): Sync.Records => ({ resetPrivate() {}, bootstrapPublic() {}, bootstrapPrivate() {}, change() {}, snapshot: () => ({ public: { stream: "public", revision: 0 }, private: null }) }) });
`,
    ".tinker/routeTree.gen.ts":
      'import { createRootRoute } from "@tanstack/react-router";\nexport const routeTree = createRootRoute();\n',
  });

  const errors = checkTypes(root);

  expect(errors).toEqual([]);
}, 20000);

test("a user's alias star export still wins over an item owner", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts": 'export * from "@/backend/own.server";\n',
    "src/backend/own.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
    "src/items/10-postgres/database.server.ts": "export default {};\n",
  });

  const server = render(root)["app.server.ts"];

  expect(server).toContain('export { database } from "@/lib/tinker.server";');
  expect(server).toContain("ownSettings(env)");
});

for (const file of ["src/lib/tinker.server.ts", "src/lib/tinker.ts"]) {
  test(`prepare and doctor refuse unreadable star exports in ${file}`, () => {
    const root = goodApp();
    prepare(root);
    write(root, {
      ".tinker/routeTree.gen.ts": "import { Route } from './../src/routes/index'\n",
      [file]: 'export * from "@acme/seam";\n',
    });

    const prepareApp = () => prepare(root);
    const checked = doctor(root, false);

    expect(prepareApp).toThrow(
      `${file}:1 has an export * whose names prepare cannot read; use explicit named exports`,
    );
    expect(checked.code).toBe(1);
    expect(checked.lines.join("\n").replaceAll(/\s+/g, " ")).toContain(
      `${file}:1 has an export * whose names prepare cannot read; use explicit named exports`,
    );
  });
}
