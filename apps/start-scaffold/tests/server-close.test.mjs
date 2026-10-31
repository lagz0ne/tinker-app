import { createMainHost } from "@tinker/start/main-host";
import { expect, test, vi } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Run the actual server command under the Start host.
import serverMain from "../cmds/server";

/** Which root's close fails in the current test, and how the app's start ends. */
const faults = vi.hoisted(() => ({ app: undefined, tools: undefined, start: undefined }));

/** A start hook that leaves a teardown error on its root, and can fail the app's start. */
const faulty = vi.hoisted(() => async (root) => {
  const { extension } = await import("@tinker/core");
  return extension({
    label: `test.fault.${root}`,
    hooks: {
      async start({ next, scope }) {
        await next();
        const cleanup = faults[root];
        if (cleanup) {
          scope.onClose(() => {
            throw cleanup;
          });
        }
        if (root === "app" && faults.start) throw faults.start;
      },
    },
  });
});

vi.mock("~/components/telemetry/index.server", async (actual) => ({
  ...(await actual()),
  telemetryExport: await faulty("tools"),
}));

vi.mock("~/components/database/index.server", async (actual) => ({
  ...(await actual()),
  databaseSetup: await faulty("app"),
}));

const env = {
  PUBLIC_ORIGIN: "http://localhost:4327",
  AUTH_SECRET: "test-secret-with-at-least-thirty-two-letters",
  DATABASE_URL: "postgres://proof@127.0.0.1:1/proof",
  SMTP_URL: "smtp://localhost:11026",
  SMTP_FROM: "test@example.test",
  OTEL_SERVICE_NAME: "proof",
  VICTORIA_TRACES_URL: "http://127.0.0.1:1/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:1/logs",
};

for (const root of ["app", "tools"]) {
  test(`a failed start with a ${root} teardown error prints one close line, then exits 1`, async () => {
    const start = new Error("start refused");
    const cleanup = new Error(`${root} cleanup refused`);
    Object.assign(faults, { app: undefined, tools: undefined, start, [root]: cleanup });
    let errors = "";
    const host = createMainHost(serverMain, {
      env,
      cwd: import.meta.dirname,
      stdout: { write() {} },
      stderr: {
        write(text) {
          errors += text;
        },
      },
    });

    expect(await host.closed).toBe(1);
    expect(errors).toBe(
      `close failed: ${String(cleanup)}\ncommand failed (exit 1): ${start.stack}\n`,
    );
  });
}

test("a bad URL before the app root opens prints the tools close failure, then exits 78", async () => {
  const cleanup = new Error("tools cleanup refused");
  Object.assign(faults, { app: undefined, tools: cleanup, start: undefined });
  let errors = "";
  const host = createMainHost(serverMain, {
    env: { ...env, DATABASE_URL: "not a url" },
    cwd: import.meta.dirname,
    stdout: { write() {} },
    stderr: {
      write(text) {
        errors += text;
      },
    },
  });

  expect(await host.closed).toBe(78);
  expect(errors).toMatch(
    /^close failed: Error: tools cleanup refused\ncommand failed \(exit 78\): TypeError: Invalid URL/,
  );
  expect(errors.match(/close failed/g)).toHaveLength(1);
});
