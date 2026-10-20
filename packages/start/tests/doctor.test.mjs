import { rmSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { imports } from "../lib/checks/imports.mjs";
import { doctor } from "../lib/doctor.mjs";
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
    "ok    1 generated folder",
    "ok    2 glue",
    "ok    3 named files",
    "ok    4 imports",
    "ok    5 routes",
    "ok    6 style",
    "skip  7 boundary",
    "doctor: all checks pass",
  ]);
  expect(code).toBe(0);
});

test("each finding prints under its check, wrapped at 50 characters for a phone", () => {
  const { lines, code } = doctor(preparedApp({ "package.json": "{}" }), false);
  expect(lines.slice(lines.indexOf("fail  2 glue"), lines.indexOf("ok    3 named files"))).toEqual([
    "fail  2 glue",
    '      package.json:1 has no "postinstall": "tinker\n      prepare"; a fresh clone has no .tinker/',
  ]);
  expect(lines.at(-1)).toBe("doctor: 1 check(s) fail");
  expect(code).toBe(1);
});

test("doctor --fix prints fixed for each check it repaired, and exits 0", () => {
  const { lines, code } = doctor(
    preparedApp({ "package.json": "{}", "tsconfig.json": "{}" }),
    true,
  );
  expect(lines.slice(lines.indexOf("fixed 2 glue"), lines.indexOf("ok    3 named files"))).toEqual([
    "fixed 2 glue",
    "      wrote the extends line in tsconfig.json and the\n      postinstall script in package.json",
  ]);
  expect(code).toBe(0);
});

test("doctor counts every failing check in its last line", () => {
  const { lines, code } = doctor(goodApp({ "package.json": "{}" }), false);
  expect(lines.filter((line) => line.startsWith("fail"))).toEqual([
    "fail  1 generated folder",
    "fail  2 glue",
  ]);
  expect(lines.at(-1)).toBe("doctor: 2 check(s) fail");
  expect(code).toBe(1);
});

for (const statement of [
  'import { secret } from "~/components/mail/secret";',
  'export { secret } from "~/components/mail/secret";',
  'const secret = import("~/components/mail/secret");',
  'type Secret = import("~/components/mail/secret").Secret;',
]) {
  test(`doctor blocks private item paths in ${statement}`, () => {
    const root = preparedApp({
      "tinker/components/mail/component.json": '{"requires":["database"]}',
      "tinker/components/mail/index.ts": "export const mail = 1;",
      "tinker/components/mail/secret.ts": "export const secret = 1;",
      "src/consumer.ts": `\n${statement}\n`,
    });

    const checked = doctor(root, false);

    expect(checked.code).toBe(1);
    expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
      'src/consumer.ts:2 "~/components/mail/secret" is private to component mail; use "~/components/mail"',
    );
    expect(checked.lines.join(" ")).not.toContain("index.server");
  });
}

for (const { file, name, symbol, messages } of [
  {
    file: "src/consumer.ts",
    name: "../tinker/components/mail/secret",
    symbol: "s",
    messages: [
      'src/consumer.ts:1 "../tinker/components/mail/secret" is private to component mail; use "~/components/mail"',
    ],
  },
  {
    file: "tinker/components/inbox/x.ts",
    name: "../mail/secret",
    symbol: "s",
    messages: [
      'tinker/components/inbox/x.ts:1 "../mail/secret" is private to component mail; use "~/components/mail"',
      'tinker/components/inbox/x.ts:1 "../mail/secret" needs "mail" in tinker/components/inbox/component.json requires',
    ],
  },
  {
    file: "tinker/components/inbox/x.ts",
    name: "../mail",
    symbol: "m",
    messages: [
      'tinker/components/inbox/x.ts:1 "../mail" needs "mail" in tinker/components/inbox/component.json requires',
    ],
  },
]) {
  test(`doctor checks the relative item import ${name} in ${file}`, () => {
    const root = preparedApp({
      "tinker/components/inbox/component.json": '{"requires":[]}',
      "tinker/components/mail/component.json": '{"requires":["database"]}',
      "tinker/components/mail/index.ts": "export const m = 1;",
      "tinker/components/mail/secret.ts": "export const s = 1;",
      [file]: `import { ${symbol} } from "${name}";`,
    });

    const checked = doctor(root, false);

    expect(checked.lines).toContain("fail  4 imports");
    for (const message of messages) {
      expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(message);
    }
  });
}

test("doctor requires a direct dependency for another item's public API", () => {
  const root = preparedApp({
    "tinker/components/mail/component.json": '{"requires":["database"]}',
    "tinker/components/mail/index.ts":
      'import { db } from "~/components/postgres"; export const mail = db;',
    "tinker/components/postgres/component.json": '{"requires":[]}',
    "tinker/components/postgres/index.ts": "export const db = 1;",
  });

  const checked = doctor(root, false);

  expect(checked.code).toBe(1);
  expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'tinker/components/mail/index.ts:1 "~/components/postgres" needs "postgres" in tinker/components/mail/component.json requires',
  );
});

test("doctor allows declared public imports, own private files, and private test imports", () => {
  const root = preparedApp({
    "tinker/components/mail/component.json": '{"requires":["database","postgres"]}',
    "tinker/components/mail/index.ts":
      'import { db } from "../postgres/index"; import { secret } from "./secret"; export const mail = db + secret;',
    "tinker/components/mail/secret.ts": "export const secret = 1;",
    "tinker/components/postgres/component.json": '{"requires":[]}',
    "tinker/components/postgres/index.ts": "export const db = 1;",
    "tinker/components/postgres/index.server.ts": "export const server = 1;",
    "src/consumer.ts":
      'import { mail } from "~/components/mail"; import { server } from "~/components/postgres/index.server";',
    "tests/mail.test.ts": 'import { secret } from "~/components/mail/secret";',
    "src/mail.test.ts": 'import { secret } from "~/components/mail/secret";',
  });

  const checked = doctor(root, false);

  expect(checked.code).toBe(0);
});

for (const name of ["~/components/postgres", "~/components/mail/../postgres"]) {
  test(`a helper-only item must declare its import of ${name}`, () => {
    const root = preparedApp({
      "tinker/components/mail/reader.ts": `import { db } from "${name}"; export const mail = db;`,
      "tinker/components/postgres/component.json": '{"requires":[]}',
      "tinker/components/postgres/index.ts": "export const db = 1;",
    });

    rmSync(join(root, "tinker/components/mail/component.json"));

    const checked = doctor(root, false);

    expect(checked.code).toBe(1);
    expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
      `tinker/components/mail/reader.ts:1 "${name}" needs "postgres"; add tinker/components/mail/component.json with { "requires": ["postgres"] }`,
    );
  });
}

test("a graph error elsewhere does not make declared imports undeclared", () => {
  const root = preparedApp({
    "tinker/components/mail/component.json": '{"requires":["database","postgres"]}',
    "tinker/components/mail/index.ts":
      'import { db } from "~/components/postgres"; export const mail = db;',
    "tinker/components/postgres/component.json": '{"requires":[]}',
    "tinker/components/postgres/index.ts": "export const db = 1;",
  });
  write(root, { "tinker/components/broken/component.json": '{"requires":["missing"]}' });

  const checked = doctor(root, false);

  expect(checked.lines).toContain("ok    4 imports");
});

test("doctor includes the server public entry for a private server import", () => {
  const root = preparedApp({
    "tinker/components/mail/component.json": '{"requires":["database"]}',
    "tinker/components/mail/index.server.ts": "export const mail = 1;",
    "tinker/components/mail/secret.server.ts": "export const secret = 1;",
    "src/consumer.server.ts": 'import { secret } from "../tinker/components/mail/secret.server";',
  });

  const checked = doctor(root, false);

  expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'src/consumer.server.ts:1 "../tinker/components/mail/secret.server" is private to component mail; use "~/components/mail" or "~/components/mail/index.server"',
  );
});

test("item tests can use private relative paths only with a declared dependency", () => {
  const root = preparedApp({
    "tinker/components/inbox/component.json": '{"requires":[]}',
    "tinker/components/inbox/x.test.ts": 'import { secret } from "../mail/secret";',
    "tinker/components/mail/component.json": '{"requires":["database"]}',
    "tinker/components/mail/secret.ts": "export const secret = 1;",
  });

  const missing = doctor(root, false);

  expect(missing.lines).toContain("fail  4 imports");
  expect(missing.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'tinker/components/inbox/x.test.ts:1 "../mail/secret" needs "mail" in tinker/components/inbox/component.json requires',
  );
  expect(missing.lines.join(" ")).not.toContain("is private");

  write(root, { "tinker/components/inbox/component.json": '{"requires":["mail"]}' });

  const declared = doctor(root, false);

  expect(declared.code).toBe(0);
});

for (const file of ["cmds/server.ts", "cmds/cli.ts", "cmds/worker.ts"]) {
  test(`doctor refuses a package import in ${file}`, () => {
    const root = preparedApp({ [file]: 'import "node:fs";\n' });

    const checked = imports(root);

    expect(checked.status).toBe("fail");
    expect(checked.lines).toEqual([
      `${file}:1 "node:fs" is not a command import; use ~/base, ~/components, @/, or @tinker/core`,
    ]);
  });
}

test("old runtime package imports fail doctor", () => {
  const root = preparedApp({
    "src/old.ts": 'import "@tinker/start";\n',
  });

  const checked = doctor(root, false);

  expect(checked.code).toBe(1);
  expect(checked.lines.join(" ").replaceAll(/\s+/g, " ")).toContain(
    'src/old.ts:1 "@tinker/start" is not a base entry',
  );
});
