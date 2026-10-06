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
