import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vite-plus/test";

test("server close fails after serving: exit 1 and print once", async () => {
  const result = await promisify(execFile)(process.execPath, ["maintain/proof-server-close.mjs"]);
  expect(result.stdout).toContain("PASS served server close failure");
});
