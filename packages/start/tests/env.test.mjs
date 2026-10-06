import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { loadEnv } from "../lib/env.mjs";
import { fixture, write } from "./fixture.mjs";

test(".env loads, a reload takes an edited value, and a dropped key goes away", () => {
  const root = fixture({ ".env": "TINKER_TEST_GREETING=hello\nTINKER_TEST_GONE=x\n" });
  loadEnv(root);
  expect(process.env.TINKER_TEST_GREETING).toBe("hello");
  write(root, { ".env": "TINKER_TEST_GREETING=bye\n" });
  loadEnv(root);
  expect(process.env.TINKER_TEST_GREETING).toBe("bye");
  expect(process.env.TINKER_TEST_GONE).toBeUndefined();
  rmSync(join(root, ".env"));
  loadEnv(root);
  expect(process.env.TINKER_TEST_GREETING).toBeUndefined();
});

test("a value set in the shell wins over .env", () => {
  process.env.TINKER_TEST_SHELL = "shell";
  loadEnv(fixture({ ".env": "TINKER_TEST_SHELL=file\n" }));
  expect(process.env.TINKER_TEST_SHELL).toBe("shell");
  delete process.env.TINKER_TEST_SHELL;
});
