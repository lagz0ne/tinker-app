import { expect, test } from "vite-plus/test";
import { boundary } from "../../lib/checks/boundary.mjs";
import { fixture } from "../fixture.mjs";

test("skips before any build has run", () => {
  expect(boundary(fixture({}))).toEqual({
    status: "skip",
    lines: ["no build has run yet; vp build checks import boundaries"],
  });
});

test("passes when the last build kept no violation", () => {
  expect(boundary(fixture({ ".tinker/violations.json": "[]" }))).toEqual({
    status: "ok",
    lines: ["the last build had no import boundary violations"],
  });
});

test("names every violation the last build kept, with its importer line", () => {
  const found = [
    {
      importer: "src/routes/leak.tsx:6:24",
      specifier: "../lib/secret.server.ts",
      env: "client",
      rule: "/\\.server\\./",
    },
    {
      importer: "src/routes/leak2.tsx:6:31",
      specifier: "../backend/greet.ts",
      env: "client",
      rule: "/\\/backend\\//",
    },
  ];
  expect(boundary(fixture({ ".tinker/violations.json": JSON.stringify(found) })).lines).toEqual([
    'src/routes/leak.tsx:6:24 imports "../lib/secret.server.ts" into client code (/\\.server\\./); call it through createServerFn, or import it only from server code',
    'src/routes/leak2.tsx:6:31 imports "../backend/greet.ts" into client code (/\\/backend\\//); call it through createServerFn, or import it only from server code',
  ]);
});
