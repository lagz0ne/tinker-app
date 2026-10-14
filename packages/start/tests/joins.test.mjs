import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";

import { doctor } from "../lib/doctor.mjs";
import { aliases } from "../lib/glue.mjs";
import { restartNote } from "../lib/hooks.mjs";
import { baseDir, basePackage, findPackage } from "../lib/paths.mjs";
import { prepare, render } from "../lib/prepare.mjs";
import { checkTypes } from "../lib/typecheck.mjs";
import { fixture, goodApp, write } from "./fixture.mjs";

test("prepare uses declared item order, then the user's seam, without reading role bodies", () => {
  const own = "export const extensions = [];\nexport const settings = () => [];\n";
  const root = goodApp({
    "src/lib/tinker.server.ts": own,
    "src/items/mail/item.json": '{"requires":["postgres"]}',
    "src/items/mail/extensions.server.ts": "export default [];\n",
    "src/items/mail/settings.server.ts": "export default () => [];\n",
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/database.server.ts": "not even parseable source",
    "src/items/postgres/settings.server.ts": "export default () => [];\n",
    "src/items/mail/extensions.ts": "export default [];\n",
    "src/items/helpers/database.ts": "export default 42;\n",
    "src/items/mail/other.server.ts": "export const database = 42;\n",
  });

  const files = render(root);
  prepare(root);

  const server = files["app.server.ts"];
  expect(server).toContain('from "@/items/postgres/database.server";');
  expect(server).toContain('from "@/items/mail/extensions.server";');
  expect(server.indexOf("postgres")).toBeLessThan(server.indexOf("mail"));
  expect(server).toContain("export const extensions = [item2Extensions, own.extensions] as const;");
  expect(server).toContain("bindings: item0Settings(env)");
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

test("ready items sort by name, including newly ready items", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\n",
    "src/items/auth/item.json": '{"requires":["db"]}',
    "src/items/auth/extensions.server.ts": "export default [];\n",
    "src/items/auth/settings.server.ts": "export default () => [];\n",
    "src/items/2fa/helper.ts": "export const helper = 42;\n",
    "src/items/db/item.json": '{"requires":[]}',
    "src/items/db/extensions.server.ts": "export default [];\n",
    "src/items/db/settings.server.ts": "export default () => [];\n",
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/settings.server.ts": "export default () => [];\n",
  });

  const server = render(root)["app.server.ts"];

  expect(server.indexOf("db")).toBeLessThan(server.indexOf("mail"));
  expect(server.indexOf("auth")).toBeLessThan(server.indexOf("mail"));
  expect(server).not.toContain("2fa");
  expect(server).toContain(
    "export const extensions = [item0Extensions, item2Extensions, own.extensions] as const;",
  );
  expect(server).toContain("  return [items, ownSettings(env)];");
});

test("two item database files fail prepare and doctor once, even with a user owner", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
  });
  prepare(root);
  write(root, {
    ".tinker/routeTree.gen.ts": "import { Route } from './../src/routes/index'\n",
    "src/items/first/item.json": '{"requires":[]}',
    "src/items/first/database.server.ts": "export default {};\n",
    "src/items/second/item.json": '{"requires":[]}',
    "src/items/second/database.server.ts": "export default {};\n",
  });

  const prepareApp = () => prepare(root);
  const checked = doctor(root, false);

  const message =
    "database: src/items/first/database.server.ts and src/items/second/database.server.ts";
  expect(prepareApp).toThrow(message);
  expect(checked.code).toBe(1);
  expect(checked.lines.join("\n").replaceAll(/\s+/g, " ").split(message)).toHaveLength(2);
});

test("adding or removing role files restarts dev; other item files do not", () => {
  expect(restartNote("/app", "/app/src/items/mail/settings.server.ts", "added")).toBe(
    "tinker: src/items/mail/settings.server.ts added; restarting",
  );
  expect(restartNote("/app", "/app/src/items/mail/extensions.ts", "removed")).toBe(
    "tinker: src/items/mail/extensions.ts removed; restarting",
  );
  expect(restartNote("/app", "/app/src/items/mail/readme.ts", "added")).toBeNull();
  expect(restartNote("/app", "/app/src/items/mail/database.ts", "added")).toBeNull();
  expect(restartNote("/app", "/app/src/items/mail/nested/settings.server.ts", "added")).toBeNull();
});

test("the user's single names win over item roles", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/database.server.ts": "export default {};\n",
  });

  const server = render(root)["app.server.ts"];

  expect(server).toContain('export { database } from "@/lib/tinker.server";');
});

test("numbered role folders must be renamed; helpers are ignored", () => {
  const root = goodApp({
    "src/items/10-mail/settings.server.ts": "export default () => [];\n",
    "src/items/notes/helpers.ts": "export const helper = 42;\n",
  });

  const prepareApp = () => prepare(root);
  const checked = doctor(root, false);

  expect(prepareApp).toThrow(
    "src/items/10-mail: rename to src/items/mail and declare requires in item.json",
  );
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
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/settings.server.ts": "export default () => [42];\n",
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/database.server.ts": "export default 42;\n",
  });

  const errors = checkTypes(root).join("\n");

  expect(errors).toContain("TS2322");
  expect(errors).toContain("TS1360");
}, 20000);

test("tsc keeps tag values and the sync change union exact through the generated seam", () => {
  const root = typedApp({
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/settings.server.ts":
      'import { tag } from "@tinker/core";\nconst smtpUrl = tag<URL>({ label: "mail.smtpUrl" });\nexport default () => [smtpUrl(new URL("smtp://mail"))];\n',
    "src/items/sync/item.json": '{"requires":[]}',
    "src/items/sync/readBatch.ts":
      'import { z } from "zod";\nexport default z.object({ version: z.number(), events: z.array(z.object({ stream: z.string(), revision: z.number(), executionId: z.string(), payload: z.object({ kind: z.literal("change"), change: z.object({ kind: z.literal("counter"), value: z.number() }) }) })) });\n',
    "src/check.ts":
      'import { readBatch } from "#tinker/app";\nexport const change: ReturnType<typeof readBatch.parse>["events"][number]["payload"]["change"] = { kind: "counter", value: 1 };\n',
  });

  const valid = checkTypes(root);

  expect(valid).toEqual([]);

  write(root, {
    "src/items/mail/settings.server.ts":
      'import { tag } from "@tinker/core";\nconst smtpUrl = tag<URL>({ label: "mail.smtpUrl" });\nexport default () => [smtpUrl("not-a-url")];\n',
    "src/check.ts":
      'import { readBatch } from "#tinker/app";\nexport const change: ReturnType<typeof readBatch.parse>["events"][number]["payload"]["change"] = { kind: "nope", value: 1 };\n',
  });

  const errors = checkTypes(root).join("\n");
  expect(errors).toContain("TS2345");
  expect(errors).toContain("TS2322");
}, 20000);

test("tsc passes when the user's seams export no list the generated file reads", () => {
  const root = typedApp({
    "src/lib/tinker.server.ts": "export const unused = 1;\n",
    "src/lib/tinker.ts": "export const settings = 1;\n",
    "src/items/mail/item.json": "{}",
    "src/items/mail/settings.server.ts": "export default () => [];\n",
    "src/items/mail/extensions.ts": "export default [];\n",
  });

  expect(checkTypes(root)).toEqual([]);
  expect(readFileSync(join(root, ".tinker/app.ts"), "utf8")).not.toContain("import * as own");
  expect(readFileSync(join(root, ".tinker/app.server.ts"), "utf8")).not.toContain(
    "import * as own",
  );
}, 20000);

test("roles accept server operations and client resources", () => {
  const root = typedApp({
    "src/items/auth/item.json": '{"requires":[]}',
    "src/items/auth/readAccount.server.ts":
      'import { operation } from "@tinker/core";\nexport default operation({ label: "account", run: () => null });\n',
    "src/items/auth/bootstrap.server.ts":
      'import { operation } from "@tinker/core";\nexport default operation({ label: "bootstrap", run: () => ({ public: { stream: "public" as const, revision: 0 }, private: null }) });\n',
    "src/items/auth/auth.server.ts":
      'import { resource } from "@tinker/core";\nexport default resource({ label: "auth", factory: () => ({ handler: async () => new Response(), api: { getSession: async () => null } }) });\n',
    "src/items/sync/item.json": '{"requires":[]}',
    "src/items/sync/records.ts": `import { resource } from "@tinker/core";
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
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/database.server.ts": "export default {};\n",
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

for (const file of ["settings.server.ts", "extensions.ts", "index.ts", "index.server.ts"]) {
  test(`prepare and doctor require item.json beside ${file}`, () => {
    const root = goodApp({ [`src/items/mail/${file}`]: "export default [];" });

    const prepareApp = () => prepare(root);
    const checked = doctor(root, false);

    const message =
      'src/items/mail: missing item.json; add src/items/mail/item.json with { "requires": [] }';
    expect(prepareApp).toThrow(message);
    expect(checked.code).toBe(1);
    expect(checked.lines.join("\n").replaceAll(/\s+/g, " ").split(message)).toHaveLength(2);
  });
}

for (const [manifest, message] of [
  ['{"requires":null}', "src/items/mail/item.json: requires must be an array of item names"],
  ['{"requires":["Bad"]}', "src/items/mail/item.json: requires must be an array of item names"],
  [
    '{"requires":["missing"]}',
    "src/items/mail/item.json: requires missing item src/items/missing; shadcn add it",
  ],
  ['{"requires":["mail"]}', "src/items/mail/item.json: cannot require itself (src/items/mail)"],
  [
    '{"requires":[],"exports":[]}',
    'src/items/mail/item.json: unknown key "exports"; only requires is allowed',
  ],
  [
    '{"requires":[],"name":"mail"}',
    'src/items/mail/item.json: unknown key "name"; only requires is allowed',
  ],
  [
    '{"requires":[],"version":"1.0.0"}',
    'src/items/mail/item.json: unknown key "version"; only requires is allowed',
  ],
  [
    '{"requires":[],"hash":"abc123"}',
    'src/items/mail/item.json: unknown key "hash"; only requires is allowed',
  ],
  ['{"requires":"postgres"}', "src/items/mail/item.json: requires must be an array of item names"],
  ["null", "src/items/mail/item.json: expected an object with only requires"],
  ["{", "src/items/mail/item.json: invalid JSON"],
]) {
  test(`prepare reports ${message}`, () => {
    const root = goodApp({
      "src/items/mail/item.json": manifest,
      "src/items/mail/settings.server.ts": "export default () => [];",
    });

    const prepareApp = () => prepare(root);

    expect(prepareApp).toThrow(message);
  });
}

test("cycles name each manifest and close the cycle", () => {
  const root = goodApp({
    "src/items/mail/item.json": '{"requires":["postgres"]}',
    "src/items/postgres/item.json": '{"requires":["errors"]}',
    "src/items/errors/item.json": '{"requires":["mail"]}',
  });

  const prepareApp = () => prepare(root);

  expect(prepareApp).toThrow(
    "item requires cycle: src/items/errors/item.json -> src/items/mail/item.json -> src/items/postgres/item.json -> src/items/errors/item.json",
  );
});

test("dependencies with only a public index still order both sides", () => {
  const root = goodApp({
    "src/items/a/item.json": '{"requires":["z"]}',
    "src/items/a/extensions.ts": "not parseable",
    "src/items/a/extensions.server.ts": "not parseable",
    "src/items/z/item.json": '{"requires":["shared"]}',
    "src/items/z/extensions.ts": "not parseable",
    "src/items/z/extensions.server.ts": "not parseable",
    "src/items/shared/item.json": '{"requires":[]}',
    "src/items/shared/index.ts": "export const shared = 1;",
  });

  const files = render(root);

  for (const side of ["app.ts", "app.server.ts"]) {
    expect(files[side].indexOf("@/items/z/")).toBeLessThan(files[side].indexOf("@/items/a/"));
  }
});

/** Load the generated seam and real item readers through the app's alias. */
async function loadApp(root) {
  const server = await createServer({
    root,
    configFile: false,
    resolve: { alias: { "@": join(root, "src") } },
    server: { middlewareMode: true, watch: null },
  });
  try {
    return await server.ssrLoadModule(join(root, ".tinker/app.server.ts"));
  } finally {
    await server.close();
  }
}

const sharedSettings = {
  "src/shared.ts":
    'import { tag } from "@tinker/core"; export const shared = tag({ label: "shared" });',
  "src/items/errors/item.json": '{"requires":[]}',
  "src/items/errors/index.ts": 'export { shared } from "@/shared";',
  "src/items/errors/settings.server.ts":
    'import { shared } from "./index"; export default () => [null, [shared("errors"), false, undefined]];',
  "src/items/mail/item.json": '{"requires":[]}',
  "src/items/mail/settings.server.ts":
    'import { shared } from "@/shared"; export default (env) => env.MAIL ? [[shared("mail")]] : [];',
};

test("unrelated item readers cannot silently override a shared tag", async () => {
  const root = typedApp(sharedSettings);

  const app = await loadApp(root);

  expect(() => app.settings({ MAIL: "on" })).toThrow(
    'src/items/errors/settings.server.ts and src/items/mail/settings.server.ts: both bind tag "shared" without a requires path; declare requires in item.json',
  );
});

test("a transitive dependency lets a reader override its tag and the user's seam stays last", async () => {
  const root = typedApp({
    ...sharedSettings,
    "src/items/postgres/item.json": '{"requires":["errors"]}',
    "src/items/mail/item.json": '{"requires":["postgres"]}',
    "src/lib/tinker.server.ts":
      'import { shared } from "@/items/errors"; export const settings = () => [shared("user")];',
  });

  const app = await loadApp(root);
  const bindings = app.settings({ MAIL: "on" }).flat(Infinity).filter(Boolean);

  expect(bindings.map((binding) => binding.value)).toEqual(["errors", "mail", "user"]);
  expect(bindings.every((binding) => binding.tag === bindings[0].tag)).toBe(true);
});

test("settings allows repeated tags in one item and absent bindings in another", async () => {
  const root = typedApp({
    ...sharedSettings,
    "src/items/errors/settings.server.ts":
      'import { shared } from "./index"; export default () => [shared("first"), [shared("last")]];',
  });

  const app = await loadApp(root);
  const bindings = app.settings({}).flat(Infinity).filter(Boolean);

  expect(bindings.map((binding) => binding.value)).toEqual(["first", "last"]);
});

test("a shared dependent does not allow two unrelated dependencies to override each other", async () => {
  const root = typedApp({
    ...sharedSettings,
    "src/items/postgres/item.json": '{"requires":["errors","mail"]}',
    "src/items/postgres/settings.server.ts":
      'import { shared } from "@/items/errors"; export default () => shared("postgres");',
  });

  const app = await loadApp(root);

  expect(() => app.settings({ MAIL: "on" })).toThrow(
    'src/items/errors/settings.server.ts and src/items/mail/settings.server.ts: both bind tag "shared" without a requires path',
  );
});

for (const verb of ["added", "removed", "changed"]) {
  test(`a manifest ${verb} restarts dev to rebuild dependency order`, () => {
    const path = "/app/src/items/mail/item.json";

    const note = restartNote("/app", path, verb);

    expect(note).toBe(`tinker: src/items/mail/item.json ${verb}; restarting`);
  });
}

test("changing a role body keeps dev's normal module reload", () => {
  expect(restartNote("/app", "/app/src/items/mail/settings.server.ts", "changed")).toBeNull();
});

for (const name of ["Mail", "mail_box", "2fa"]) {
  test(`prepare rejects invalid item name ${name}`, () => {
    const root = goodApp({ [`src/items/${name}/extensions.ts`]: "not parseable" });

    const prepareApp = () => prepare(root);

    expect(prepareApp).toThrow(`src/items/${name}: item names must match [a-z][a-z0-9-]*`);
  });
}

test("equal tag labels do not make distinct tags clash", async () => {
  const root = typedApp({
    "src/items/errors/item.json": '{"requires":[]}',
    "src/items/errors/settings.server.ts":
      'import { tag } from "@tinker/core"; const value = tag({ label: "shared" }); export default () => value("errors");',
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/settings.server.ts":
      'import { tag } from "@tinker/core"; const value = tag({ label: "shared" }); export default () => value("mail");',
  });

  const app = await loadApp(root);
  const bindings = app.settings({}).flat(Infinity).filter(Boolean);

  expect(bindings[0].tag).not.toBe(bindings[1].tag);
});

test("prepare refuses a seam star export that would read an item index", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts": 'export * from "@/backend/seam.server";',
    "src/backend/seam.server.ts": 'export * from "@/items/mail";',
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/index.ts": "export const settings = () => [];",
  });

  const prepareApp = () => prepare(root);

  expect(prepareApp).toThrow(
    "src/lib/tinker.server.ts:1 has an export * whose names prepare cannot read; use explicit named exports",
  );
});

test("prepare can read explicit seam exports without reading item source", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts": 'export { settings } from "@/items/mail";',
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/index.ts": "not parseable",
    "src/items/mail/settings.server.ts": "not parseable",
  });

  const server = render(root)["app.server.ts"];

  expect(server).toContain("const ownSettings: App.Settings = own.settings;");
});
