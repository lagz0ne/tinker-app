import { expect, test } from "vite-plus/test";
import { style } from "../../lib/checks/style.mjs";
import { prepare } from "../../lib/prepare.mjs";
import { goodApp } from "../fixture.mjs";

const tailwindInstalled = {
  "node_modules/tailwindcss/package.json": JSON.stringify({ version: "4.0.0" }),
  "node_modules/@tailwindcss/vite/package.json": JSON.stringify({ version: "4.0.0" }),
};
const shadcn = (settings) =>
  JSON.stringify(
    { tailwind: { css: "src/style.css" }, aliases: { ui: "@/components/ui" }, ...settings },
    null,
    2,
  );

test("passes when the shell links src/style.css and no stylesheet sits unlinked", () => {
  const root = goodApp({
    "src/style.css": '@import "./theme.css";\n',
    "src/theme.css": "",
    "src/frontend/card.css": "",
    "src/frontend/card.tsx": 'import "./card.css";\n',
  });
  expect(style(root)).toEqual({
    status: "ok",
    lines: ["src/style.css is linked by the shell; every stylesheet is linked"],
  });
});

test("names a user shell that does not link src/style.css", () => {
  const root = goodApp({
    "src/style.css": "",
    "src/routes/__root.tsx": "export const Route = 1;\n",
  });
  expect(style(root).lines).toEqual([
    'src/routes/__root.tsx:1 replaces the base shell and does not link src/style.css; import style from "../style.css?url" and add { rel: "stylesheet", href: style } to head links',
  ]);
  const linked = goodApp({
    "src/style.css": "",
    "src/routes/__root.tsx": 'import style from "../style.css?url";\n',
  });
  expect(style(linked).status).toBe("ok");
});

test("a comment that names style.css?url does not link it; an @/ import does", () => {
  const comment = goodApp({
    "src/style.css": "",
    "src/routes/__root.tsx": '// import style from "../style.css?url"\nexport const Route = 1;\n',
  });
  expect(style(comment).lines).toEqual([
    'src/routes/__root.tsx:1 replaces the base shell and does not link src/style.css; import style from "../style.css?url" and add { rel: "stylesheet", href: style } to head links',
  ]);
  const alias = goodApp({
    "src/style.css": "",
    "src/routes/__root.tsx": 'import style from "@/style.css?url";\nexport const Route = style;\n',
  });
  expect(style(alias).status).toBe("ok");
});

test("a commented-out @import of tailwindcss needs no Tailwind package", () => {
  expect(style(goodApp({ "src/style.css": '/* @import "tailwindcss"; */\n' })).status).toBe("ok");
});

test("a components.json that does not parse is named at its line, not thrown", () => {
  const root = goodApp({
    "components.json": '{\n  "aliases": { "ui": "@/components/ui" }\n  "tailwind": {}\n}\n',
  });
  expect(style(root).lines).toEqual(["components.json:3 does not parse (CommaExpected)"]);
});

test("components.json is strict JSON, as shadcn reads it: a trailing comma does not parse", () => {
  const root = goodApp({
    "components.json": '{\n  "aliases": { "ui": "@/components/ui", }\n}\n',
  });
  expect(style(root).lines).toEqual(["components.json:2 does not parse (PropertyNameExpected)"]);
});

test("components.json is strict JSON: a byte order mark does not parse", () => {
  const root = goodApp({ "components.json": '\uFEFF{ "tailwind": { "css": "src/style.css" } }\n' });
  expect(style(root).lines).toEqual(["components.json:1 does not parse (ByteOrderMark)"]);
});

test("names a components.json that sets no tailwind.css", () => {
  const root = goodApp({ "components.json": '{ "aliases": {} }\n' });
  prepare(root);
  expect(style(root).lines).toEqual([
    'components.json:1 sets no tailwind.css; set it to "src/style.css"',
  ]);
});

test("reads tsconfig.json as tsc does, so a comment does not hide shadcn's aliases", () => {
  const root = goodApp({
    ...tailwindInstalled,
    "components.json": shadcn({}),
    "src/style.css": '@import "tailwindcss";\n',
    "tsconfig.json": '{\n  // glue\n  "extends": "./.tinker/tsconfig.json",\n}\n',
  });
  prepare(root);
  expect(style(root).status).toBe("ok");
});

test("reads shadcn's aliases through an extends array, the last file winning", () => {
  const root = goodApp({
    ...tailwindInstalled,
    "components.json": shadcn({}),
    "src/style.css": '@import "tailwindcss";\n',
    "strict.json": "{}\n",
    "tsconfig.json":
      '{ "extends": ["@tsconfig/strictest", "./.tinker/tsconfig.json", "./strict.json"] }\n',
  });
  prepare(root);
  expect(style(root).status).toBe("ok");
});

test("names a stylesheet nothing links", () => {
  expect(style(goodApp({ "src/styles.css": "" })).lines).toEqual([
    "src/styles.css:1 is never linked: nothing imports it, and the shell links only src/style.css",
  ]);
});

test("names each Tailwind package a stylesheet needs and the app lacks", () => {
  const root = goodApp({ "src/style.css": '/* app */\n@import "tailwindcss";\n' });
  expect(style(root).lines).toEqual([
    "src/style.css:2 imports tailwindcss, but tailwindcss is not installed; tinker() adds Tailwind when it is",
    "src/style.css:2 imports tailwindcss, but @tailwindcss/vite is not installed; tinker() adds Tailwind when it is",
  ]);
});

test("passes shadcn when its aliases land in src/ and Tailwind runs from src/style.css", () => {
  const root = goodApp({
    ...tailwindInstalled,
    "components.json": shadcn({}),
    "src/style.css": '@import "tailwindcss";\n',
  });
  prepare(root);
  expect(style(root).status).toBe("ok");
});

test("names a shadcn alias that lands outside src/, as a relative path did", () => {
  const root = goodApp({
    ...tailwindInstalled,
    "components.json": shadcn({}),
    "src/style.css": '@import "tailwindcss";\n',
    ".tinker/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@/*": ["../src/*"] } },
    }),
  });
  expect(style(root).lines).toEqual([
    'components.json:6 aliases.ui "@/components/ui" lands at ../src/components/ui, outside src/; shadcn writes there',
  ]);
});

test("names a shadcn alias with no path, and a CSS file the base does not link", () => {
  const root = goodApp({
    ...tailwindInstalled,
    "components.json": shadcn({ tailwind: { css: "src/app.css" }, aliases: { ui: "~/ui" } }),
  });
  prepare(root);
  expect(style(root).lines).toEqual([
    'components.json:6 aliases.ui "~/ui" matches no tsconfig path',
    'components.json:3 tailwind.css is "src/app.css"; the base links src/style.css',
  ]);
});

test("a components.json with no UI file yet needs no stylesheet", () => {
  const root = goodApp({ "components.json": shadcn({}) });
  prepare(root);
  expect(style(root)).toEqual({
    status: "ok",
    lines: ["no src/style.css; every stylesheet is linked"],
  });
});

test("reads Tailwind's import with single quotes and any spacing", () => {
  const root = goodApp({ "src/style.css": "@import\t 'tailwindcss';\n", ...tailwindInstalled });
  expect(style(root).status).toBe("ok");
  const missing = goodApp({ "src/style.css": "@import\t 'tailwindcss';\n" });
  expect(style(missing).lines).toHaveLength(2);
  const button = { "src/components/ui/button.tsx": "export const Button = 1;\n" };
  const ui = goodApp({
    "components.json": shadcn({}),
    "src/style.css": "@import  'tailwindcss';\n",
    ...tailwindInstalled,
    ...button,
  });
  prepare(ui);
  expect(style(ui).status).toBe("ok");
});

test("names a missing or Tailwind-less stylesheet once shadcn has a UI file", () => {
  const button = { "src/components/ui/button.tsx": "export const Button = 1;\n" };
  const missing = goodApp({ "components.json": shadcn({}), ...button });
  prepare(missing);
  expect(style(missing).lines).toEqual([
    'src/style.css is missing; shadcn\'s files in src/components/ui need it, with @import "tailwindcss"',
  ]);
  const plain = goodApp({ "components.json": shadcn({}), "src/style.css": "body {}\n", ...button });
  prepare(plain);
  expect(style(plain).lines).toEqual([
    'src/style.css:1 does not @import "tailwindcss"; shadcn\'s files in src/components/ui need Tailwind',
  ]);
});
