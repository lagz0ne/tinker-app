import { createMainHost } from "@tinker/start/main-host";
import { expect, test } from "vite-plus/test";

// oxlint-disable-next-line import/no-relative-parent-imports -- Run the actual commands under the Start host.
import serverMain from "../cmds/server";
// oxlint-disable-next-line import/no-relative-parent-imports -- Run the actual commands under the Start host.
import workerMain from "../cmds/worker";

/** Run a command under the Start host, as `tinker serve` and `runMain` do; give its code and stderr. */
const hosted = async (main, env, args = []) => {
  let errors = "";
  const host = createMainHost(main, {
    env,
    args,
    cwd: import.meta.dirname,
    stdout: { write() {} },
    stderr: {
      write(text) {
        errors += text;
      },
    },
  });
  const app = await host.started.catch(() => undefined);

  return { app, code: await host.closed, errors };
};

const missingTag = /^command failed \(exit 78\): MissingTag: \{.*\}\n$/;

test("server startup with no config throws, and the host exits 78 with one line", async () => {
  const { app, code, errors } = await hosted(serverMain, {});

  expect(app).toBeUndefined();
  expect(code).toBe(78);
  expect(errors).toMatch(missingTag);
});

test("server with extra args exits 64 with usage, and its fetch is stopped", async () => {
  const { app, code, errors } = await hosted(serverMain, {}, ["extra"]);

  expect(code).toBe(64);
  expect(errors).toBe("Usage: tinker serve\n");
  expect((await app.fetch(new Request("http://proof.test"))).status).toBe(503);
});

test("server with a bad URL exits 78", async () => {
  const { code, errors } = await hosted(serverMain, { VICTORIA_TRACES_URL: "not a url" });

  expect(code).toBe(78);
  expect(errors).toMatch(/^command failed \(exit 78\): TypeError: Invalid URL/);
});

test("worker startup with no config throws, and the host exits 78 with one line", async () => {
  const { app, code, errors } = await hosted(workerMain, {});

  expect(app).toBeUndefined();
  expect(code).toBe(78);
  expect(errors).toMatch(missingTag);
});

test("worker with extra args exits 64 with usage", async () => {
  const { code, errors } = await hosted(workerMain, {}, ["extra"]);

  expect(code).toBe(64);
  expect(errors).toBe("Usage: worker\n");
});

for (const key of ["VICTORIA_TRACES_URL", "VICTORIA_LOGS_URL"]) {
  test(`worker requires the matching collector URL when only ${key} is bound`, async () => {
    const { code, errors } = await hosted(workerMain, {
      [key]: "http://127.0.0.1:19123/collector",
    });

    expect(code).toBe(78);
    expect(errors).toMatch(missingTag);
    const label = key === "VICTORIA_TRACES_URL" ? "telemetry.logsUrl" : "telemetry.tracesUrl";
    expect(errors).toContain(`"label":"${label}"`);
  });
}
