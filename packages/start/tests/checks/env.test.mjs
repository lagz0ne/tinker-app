import { expect, test } from "vite-plus/test";
import { env } from "../../lib/checks/env.mjs";
import { fixture } from "../fixture.mjs";

test("passes with no .env.example", () => {
  expect(env(fixture({}))).toEqual({ status: "ok", lines: ["no .env.example; no keys to check"] });
});

test("passes when each listed key is set in .env or the shell", () => {
  process.env.TINKER_TEST_SHELL_KEY = "from-shell";
  const root = fixture({
    ".env.example": "TINKER_TEST_FILE_KEY=\nTINKER_TEST_SHELL_KEY=\n",
    ".env": "TINKER_TEST_FILE_KEY=yes\n",
  });
  expect(env(root)).toEqual({ status: "ok", lines: ["2 key(s) from .env.example are set"] });
  delete process.env.TINKER_TEST_SHELL_KEY;
});

test("names each listed key that is set nowhere, at its .env.example line", () => {
  const root = fixture({ ".env.example": "# keys\nTINKER_TEST_UNSET_KEY=\n" });
  expect(env(root).lines).toEqual([
    ".env.example:2 lists TINKER_TEST_UNSET_KEY; set it in .env or the shell",
  ]);
});
