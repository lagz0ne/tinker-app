import { expect, test } from "vite-plus/test";
import { pinDependencies } from "../lib/upgrade.mjs";

const tested = {
  "@tanstack/react-router": "1.170.41",
  "@tinker/core": "0.0.0",
  "@tinker/react": "0.0.0",
};

test("an upgrade sets the new base and pins each drifted peer to the tested version", () => {
  const { dependencies, changes } = pinDependencies(
    {
      "@tinker/start": "file:packs/tinker-start-0.1.0.tgz",
      "@tanstack/react-router": "1.160.0",
      zod: "^4",
    },
    "file:packs/tinker-start-0.2.0.tgz",
    tested,
    () => null,
  );
  expect(dependencies).toEqual({
    "@tinker/start": "file:packs/tinker-start-0.2.0.tgz",
    "@tanstack/react-router": "1.170.41",
    zod: "^4",
  });
  expect(changes).toEqual([
    ["@tinker/start", "file:packs/tinker-start-0.1.0.tgz", "file:packs/tinker-start-0.2.0.tgz"],
    ["@tanstack/react-router", "1.160.0", "1.170.41"],
  ]);
});

test("workspace, catalog, and tarball specs that install the tested version stay", () => {
  const { changes } = pinDependencies(
    {
      "@tinker/start": "0.1.0",
      "@tanstack/react-router": "catalog:",
      "@tinker/core": "workspace:*",
      "@tinker/react": "file:packs/tinker-react.tgz",
    },
    "0.2.0",
    tested,
    (name) => (name === "@tinker/react" ? "0.0.0" : null),
  );
  expect(changes).toEqual([["@tinker/start", "0.1.0", "0.2.0"]]);
});
