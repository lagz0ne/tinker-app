import { expect, test } from "vite-plus/test";
import { examples } from "../../lib/checks/examples.mjs";
import { named } from "../../lib/checks/named.mjs";
import { goodApp, write } from "../fixture.mjs";

const receipt = JSON.stringify({
  name: "demo",
  parts: ["auth", "sync"],
  seams: {
    "src/lib/tinker.server.ts": {
      auth: { line: 'export { auth } from "../backend/auth";' },
      extensions: {
        line: 'export { extensions } from "../examples/demo.server";',
        from: "../examples/demo.server.ts",
        include: { name: "databaseSetup", from: "../backend/database.ts" },
      },
    },
  },
});

test("an installed example names each missing part switch and the export lines", () => {
  const root = goodApp({ "src/examples/demo.tinker.json": receipt });
  expect(examples(root).lines).toEqual([
    "demo: needs the auth part; set tinker({ auth: true }) in vite.config.ts",
    "demo: needs the sync part; set tinker({ sync: true }) in vite.config.ts",
    'demo: src/lib/tinker.server.ts:1 needs auth; add export { auth } from "../backend/auth";',
    'demo: src/lib/tinker.server.ts:1 needs extensions; add export { extensions } from "../examples/demo.server";',
  ]);
});

test("an empty extension list does not install the example's database startup", () => {
  const root = goodApp({
    "src/examples/demo.tinker.json": receipt,
    ".tinker/base.json": JSON.stringify({ parts: ["auth", "sync"] }),
    "src/lib/tinker.server.ts": "export const auth = 1; export const extensions = [];",
  });
  expect(examples(root).lines).toEqual([
    'demo: src/lib/tinker.server.ts:1 needs databaseSetup in extensions; keep your extensions and add it, or use export { extensions } from "../examples/demo.server";',
  ]);
});

test("example exports and a startup re-export satisfy the copied requirements", () => {
  const root = goodApp({
    "src/examples/demo.tinker.json": receipt,
    ".tinker/base.json": JSON.stringify({ parts: ["auth", "sync"] }),
    "src/lib/tinker.server.ts":
      'export const auth = 1; export { extensions } from "../examples/demo.server";',
  });
  expect(examples(root)).toEqual({
    status: "ok",
    lines: ["installed examples have their parts and seam exports"],
  });
});

test("a user can join database startup to an existing extension list under an import alias", () => {
  const root = goodApp({
    "src/examples/demo.tinker.json": receipt,
    ".tinker/base.json": JSON.stringify({ parts: ["auth", "sync"] }),
    "src/lib/tinker.server.ts":
      'import { databaseSetup as setup } from "../backend/database"; export const auth = 1; const mine = {}; export const extensions = [mine, setup];',
  });
  expect(examples(root).status).toBe("ok");
  write(root, {
    "src/lib/tinker.server.ts":
      'import { extensions as demo } from "../examples/demo.server"; export const auth = 1; const mine = {}; export const extensions = [mine, ...demo];',
  });
  expect(examples(root).status).toBe("ok");
});

test("a missing export in an existing seam gets the item's exact export line", () => {
  const root = goodApp({
    "src/examples/demo.tinker.json": receipt,
    ".tinker/base.json": JSON.stringify({ parts: ["auth", "sync"] }),
    "src/lib/tinker.server.ts": 'export { extensions } from "../examples/demo.server";',
  });
  expect(examples(root).lines).toEqual([
    'demo: src/lib/tinker.server.ts:1 needs auth; add export { auth } from "../backend/auth";',
  ]);
});

test("ordinary example JSON is not an install receipt", () => {
  expect(examples(goodApp({ "src/examples/data.json": "{}" })).status).toBe("ok");
});

test("a user can export the copied demo server seam as a whole", () => {
  const root = goodApp({
    "src/examples/demo.tinker.json": receipt,
    ".tinker/base.json": JSON.stringify({ parts: ["auth", "sync"] }),
    "src/examples/demo.server.ts": "export const auth = 1; export const extensions = [];",
    "src/lib/tinker.server.ts": 'export * from "../examples/demo.server";',
  });
  expect(examples(root).status).toBe("ok");
});

test("doctor's named check includes an installed example's part switch", () => {
  const result = named(goodApp({ "src/examples/demo.tinker.json": receipt }));
  expect(result.lines).toContain(
    "demo: needs the sync part; set tinker({ sync: true }) in vite.config.ts",
  );
});
