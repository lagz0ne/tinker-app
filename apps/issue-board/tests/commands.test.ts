import { expect, test } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Exercise the command entry itself.
import cliMain from "../cmds/cli";
// oxlint-disable-next-line import/no-relative-parent-imports -- Exercise the command entry itself.
import serverMain from "../cmds/server";

test("server missing database startup tag exits 78 before any generic close code", async () => {
  const codes: number[] = [];

  let errors = "";

  const app = await serverMain({
    env: {
      PUBLIC_ORIGIN: "http://localhost:4327",
      AUTH_SECRET: "test-secret-with-at-least-thirty-two-letters",
      SMTP_URL: "smtp://localhost:11026",
      SMTP_FROM: "test@example.test",
      OTEL_SERVICE_NAME: "proof",
      VICTORIA_TRACES_URL: "http://localhost:11428",
      VICTORIA_LOGS_URL: "http://localhost:19428",
    },
    args: [],
    signal: new AbortController().signal,
    stdout: { write() {} },
    stderr: {
      write(text) {
        errors += text;
      },
    },
    exit(code) {
      codes.push(code);
    },
  });

  await app.closed;

  expect(codes).toEqual([78]);

  expect(errors).toContain("MissingTag");
});

test("CLI missing database startup tag exits 78", async () => {
  const codes: number[] = [];

  const app = await cliMain({
    env: {},
    args: ["--file", "proof.csv", "--team", "ENG", "--actor", "proof@example.test"],
    signal: new AbortController().signal,
    stdout: { write() {} },
    stderr: { write() {} },
    exit(code) {
      codes.push(code);
    },
  });

  await app.closed;

  expect(codes).toEqual([78]);
});
