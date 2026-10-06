import { expect, test } from "vite-plus/test";
import { env } from "../../lib/checks/env.mjs";
import { fixture } from "../fixture.mjs";

test("passes with no .env.example", () => {
  expect(env(fixture({}))).toEqual({
    status: "ok",
    lines: ["no .env.example to check; part keys read well: telemetry"],
  });
});

test("passes when each listed key is set in .env or the shell", () => {
  process.env.TINKER_TEST_SHELL_KEY = "from-shell";
  const root = fixture({
    ".env.example": "TINKER_TEST_FILE_KEY=\nTINKER_TEST_SHELL_KEY=\n",
    ".env": "TINKER_TEST_FILE_KEY=yes\n",
  });
  expect(env(root)).toEqual({
    status: "ok",
    lines: ["2 key(s) from .env.example are set; part keys read well: telemetry"],
  });
  delete process.env.TINKER_TEST_SHELL_KEY;
});

test("names each listed key that is set nowhere, at its .env.example line", () => {
  const root = fixture({ ".env.example": "# keys\nTINKER_TEST_UNSET_KEY=\n" });
  expect(env(root).lines).toEqual([
    ".env.example:2 lists TINKER_TEST_UNSET_KEY; set it in .env or the shell",
  ]);
});

test("names an on part's key whose .env value the part refuses, at its .env line", () => {
  const root = fixture({
    ".env": "# telemetry\nVICTORIA_TRACES_URL=not a url\nOTEL_SERVICE_NAME=shop\n",
  });
  expect(env(root)).toMatchObject({
    status: "fail",
    lines: [".env:2 sets VICTORIA_TRACES_URL; the telemetry part needs an http(s) URL"],
  });
});

test("a refused value from the shell is named as the shell's, and wins over .env", () => {
  process.env.VICTORIA_LOGS_URL = "ftp://logs.example";
  const root = fixture({ ".env": "VICTORIA_LOGS_URL=http://127.0.0.1:9428/insert/jsonline\n" });
  expect(env(root).lines).toEqual([
    "the shell sets VICTORIA_LOGS_URL; the telemetry part needs an http(s) URL",
  ]);
  delete process.env.VICTORIA_LOGS_URL;
});

test("a good shell value hides a bad .env one, as the part reads the shell first", () => {
  process.env.VICTORIA_TRACES_URL = "https://traces.example/insert";
  const root = fixture({ ".env": "VICTORIA_TRACES_URL=not a url\n" });
  expect(env(root).status).toBe("ok");
  delete process.env.VICTORIA_TRACES_URL;
});

test("an off part's keys are not checked", () => {
  const root = fixture({
    ".tinker/base.json": JSON.stringify({ base: "0.3.0", parts: [] }),
    ".env": "VICTORIA_TRACES_URL=not a url\n",
  });
  expect(env(root)).toEqual({ status: "ok", lines: ["no .env.example to check"] });
});
