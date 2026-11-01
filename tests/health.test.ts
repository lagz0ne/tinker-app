import { expect, test } from "bun:test";

import { baseVersion } from "~/components/health";

test("the base version is the template version in package.json", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(baseVersion).toBe(pkg.version);
});
