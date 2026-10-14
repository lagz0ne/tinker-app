import { expect, test } from "vite-plus/test";

import { doctor } from "../lib/doctor.mjs";
import { basePackage } from "../lib/paths.mjs";
import { prepare } from "../lib/prepare.mjs";
import { goodApp, write } from "./fixture.mjs";

/** A good app after `tinker prepare`, with its route tree written. */
function preparedApp(files = {}) {
  const root = goodApp(files);
  prepare(root);
  write(root, {
    ".tinker/routeTree.gen.ts":
      "import { Route as IndexRouteImport } from './../src/routes/index'\n",
  });
  return root;
}

test("doctor prints a status line per check, in order, and passes with exit 0", () => {
  const { lines, code } = doctor(preparedApp(), false);
  expect(lines.filter((line) => !line.startsWith(" "))).toEqual([
    "ok    1 base version",
    "skip  2 base bytes",
    "ok    3 generated folder",
    "ok    4 glue",
    "ok    5 named files",
    "ok    6 imports",
    "ok    7 routes",
    "ok    8 style",
    "ok    9 env",
    "skip  10 boundary",
    "doctor: all checks pass",
  ]);
  expect(code).toBe(0);
});

test("each finding prints under its check, wrapped at 50 characters for a phone", () => {
  const { lines, code } = doctor(preparedApp({ "package.json": "{}" }), false);
  expect(lines.slice(lines.indexOf("fail  4 glue"), lines.indexOf("ok    5 named files"))).toEqual([
    "fail  4 glue",
    '      package.json:1 has no "postinstall": "tinker\n      prepare"; a fresh clone has no .tinker/',
  ]);
  expect(lines.slice(0, 2)).toEqual([
    "ok    1 base version",
    `      @tinker/start ${basePackage.version}; 4 peers match the tested\n      versions`,
  ]);
  expect(lines.at(-1)).toBe("doctor: 1 check(s) fail");
  expect(code).toBe(1);
});

test("doctor --fix prints fixed for each check it repaired, and exits 0", () => {
  const { lines, code } = doctor(
    preparedApp({ "package.json": "{}", "tsconfig.json": "{}" }),
    true,
  );
  expect(lines.slice(lines.indexOf("fixed 4 glue"), lines.indexOf("ok    5 named files"))).toEqual([
    "fixed 4 glue",
    "      wrote the extends line in tsconfig.json and the\n      postinstall script in package.json",
  ]);
  expect(code).toBe(0);
});

test("doctor counts every failing check in its last line", () => {
  const { lines, code } = doctor(goodApp({ "package.json": "{}" }), false);
  expect(lines.filter((line) => line.startsWith("fail"))).toEqual([
    "fail  3 generated folder",
    "fail  4 glue",
  ]);
  expect(lines.at(-1)).toBe("doctor: 2 check(s) fail");
  expect(code).toBe(1);
});

for (const statement of [
  'import { secret } from "@/items/mail/secret";',
  'export { secret } from "@/items/mail/secret";',
  'const secret = import("@/items/mail/secret");',
  'type Secret = import("@/items/mail/secret").Secret;',
]) {
  test(`doctor blocks private item paths in ${statement}`, () => {
    const root = preparedApp({
      "src/items/mail/item.json": '{"requires":[]}',
      "src/items/mail/index.ts": "export const mail = 1;",
      "src/items/mail/secret.ts": "export const secret = 1;",
      "src/consumer.ts": `\n${statement}\n`,
    });

    const checked = doctor(root, false);

    expect(checked.code).toBe(1);
    expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
      'src/consumer.ts:2 "@/items/mail/secret" is private to item mail; use "@/items/mail"',
    );
    expect(checked.lines.join(" ")).not.toContain("index.server");
  });
}

for (const { file, name, symbol, messages } of [
  {
    file: "src/consumer.ts",
    name: "./items/mail/secret",
    symbol: "s",
    messages: [
      'src/consumer.ts:1 "./items/mail/secret" is private to item mail; use "@/items/mail"',
    ],
  },
  {
    file: "src/items/inbox/x.ts",
    name: "../mail/secret",
    symbol: "s",
    messages: [
      'src/items/inbox/x.ts:1 "../mail/secret" is private to item mail; use "@/items/mail"',
      'src/items/inbox/x.ts:1 "../mail/secret" needs "mail" in src/items/inbox/item.json requires',
    ],
  },
  {
    file: "src/items/inbox/x.ts",
    name: "../mail",
    symbol: "m",
    messages: [
      'src/items/inbox/x.ts:1 "../mail" needs "mail" in src/items/inbox/item.json requires',
    ],
  },
]) {
  test(`doctor checks the relative item import ${name} in ${file}`, () => {
    const root = preparedApp({
      "src/items/inbox/item.json": '{"requires":[]}',
      "src/items/mail/item.json": '{"requires":[]}',
      "src/items/mail/index.ts": "export const m = 1;",
      "src/items/mail/secret.ts": "export const s = 1;",
      [file]: `import { ${symbol} } from "${name}";`,
    });

    const checked = doctor(root, false);

    expect(checked.lines).toContain("fail  6 imports");
    for (const message of messages) {
      expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(message);
    }
  });
}

test("doctor requires a direct dependency for another item's public API", () => {
  const root = preparedApp({
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/index.ts": 'import { db } from "@/items/postgres"; export const mail = db;',
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/index.ts": "export const db = 1;",
  });

  const checked = doctor(root, false);

  expect(checked.code).toBe(1);
  expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'src/items/mail/index.ts:1 "@/items/postgres" needs "postgres" in src/items/mail/item.json requires',
  );
});

test("doctor allows declared public imports, own private files, and private test imports", () => {
  const root = preparedApp({
    "src/items/mail/item.json": '{"requires":["postgres"]}',
    "src/items/mail/index.ts":
      'import { db } from "../postgres/index"; import { secret } from "./secret"; export const mail = db + secret;',
    "src/items/mail/secret.ts": "export const secret = 1;",
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/index.ts": "export const db = 1;",
    "src/items/postgres/index.server.ts": "export const server = 1;",
    "src/consumer.ts":
      'import { mail } from "@/items/mail"; import { server } from "@/items/postgres/index.server";',
    "tests/mail.test.ts": 'import { secret } from "@/items/mail/secret";',
    "src/mail.test.ts": 'import { secret } from "@/items/mail/secret";',
  });

  const checked = doctor(root, false);

  expect(checked.code).toBe(0);
});

for (const name of ["@/items/postgres", "@/items/mail/../postgres"]) {
  test(`a helper-only item must declare its import of ${name}`, () => {
    const root = preparedApp({
      "src/items/mail/reader.ts": `import { db } from "${name}"; export const mail = db;`,
      "src/items/postgres/item.json": '{"requires":[]}',
      "src/items/postgres/index.ts": "export const db = 1;",
    });

    const checked = doctor(root, false);

    expect(checked.code).toBe(1);
    expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
      `src/items/mail/reader.ts:1 "${name}" needs "postgres"; add src/items/mail/item.json with { "requires": ["postgres"] }`,
    );
  });
}

test("a graph error elsewhere does not make declared imports undeclared", () => {
  const root = preparedApp({
    "src/items/mail/item.json": '{"requires":["postgres"]}',
    "src/items/mail/index.ts": 'import { db } from "@/items/postgres"; export const mail = db;',
    "src/items/postgres/item.json": '{"requires":[]}',
    "src/items/postgres/index.ts": "export const db = 1;",
  });
  write(root, { "src/items/broken/item.json": '{"requires":["missing"]}' });

  const checked = doctor(root, false);

  expect(checked.lines).toContain("ok    6 imports");
});

test("doctor includes the server public entry for a private server import", () => {
  const root = preparedApp({
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/index.server.ts": "export const mail = 1;",
    "src/items/mail/secret.server.ts": "export const secret = 1;",
    "src/consumer.server.ts": 'import { secret } from "./items/mail/secret.server";',
  });

  const checked = doctor(root, false);

  expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'src/consumer.server.ts:1 "./items/mail/secret.server" is private to item mail; use "@/items/mail" or "@/items/mail/index.server"',
  );
});

test("item tests can use private relative paths only with a declared dependency", () => {
  const root = preparedApp({
    "src/items/inbox/item.json": '{"requires":[]}',
    "src/items/inbox/x.test.ts": 'import { secret } from "../mail/secret";',
    "src/items/mail/item.json": '{"requires":[]}',
    "src/items/mail/secret.ts": "export const secret = 1;",
  });

  const missing = doctor(root, false);

  expect(missing.lines).toContain("fail  6 imports");
  expect(missing.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'src/items/inbox/x.test.ts:1 "../mail/secret" needs "mail" in src/items/inbox/item.json requires',
  );
  expect(missing.lines.join(" ")).not.toContain("is private");

  write(root, { "src/items/inbox/item.json": '{"requires":["mail"]}' });

  const declared = doctor(root, false);

  expect(declared.code).toBe(0);
});
