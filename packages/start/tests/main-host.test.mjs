import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";

import { expect, test, vi } from "vite-plus/test";

import { createMainHost } from "../lib/main-host.mjs";

const quiet = { write() {} };

test("exit during start aborts inputs, skips listening, and joins closed", async () => {
  const finish = Promise.withResolvers();

  const events = [];

  const host = createMainHost(
    async ({ signal, exit }) => {
      events.push("start");
      exit(64, "usage");
      expect(signal.reason).toBe("usage");
      return {
        closed: finish.promise.then(() => {
          events.push("closed");
        }),
      };
    },
    {
      env: {},
      stdout: quiet,
      stderr: quiet,
      onStart: () => {
        events.push("listen");
      },
    },
  );

  await host.started;

  expect(events).toEqual(["start"]);
  finish.resolve();

  expect(await host.closed).toBe(64);

  expect(events).toEqual(["start", "closed"]);
});

test("exit twice keeps the first code and reason", async () => {
  const host = createMainHost(
    async ({ exit }) => {
      exit(65, "first");
      exit(78, "second");

      return { closed: Promise.resolve() };
    },
    { env: {}, stdout: quiet, stderr: quiet },
  );

  expect(await host.closed).toBe(65);

  expect(host.signal.reason).toBe("first");
});

test("exit followed by SIGTERM keeps the command's first code", async () => {
  const finish = Promise.withResolvers();

  const host = createMainHost(
    async ({ exit }) => {
      exit(64, "first");
      return { closed: finish.promise };
    },
    { env: {}, stdout: quiet, stderr: quiet },
  );

  await host.started;

  host.stop(143, "SIGTERM");
  finish.resolve();

  expect(await host.closed).toBe(64);

  expect(host.signal.reason).toBe("first");
});

test("a throw after exit is logged and keeps the first code", async () => {
  let errors = "";

  const host = createMainHost(
    async ({ exit }) => {
      exit(0, "clean");
      throw new Error("late failure");
    },
    {
      env: {},
      stdout: quiet,
      stderr: {
        write: (chunk) => {
          errors += chunk;
        },
      },
    },
  );

  expect(await host.closed).toBe(0);

  expect(errors).toContain("late failure");
});

test("stdout is flushed after closed and before the host returns an exit code", async () => {
  const bytes = [];

  const stream = new Writable({
    write(chunk, _encoding, done) {
      setImmediate(() => {
        bytes.push(chunk.toString());
        done();
      });
    },
  });

  const host = createMainHost(
    async ({ stdout, exit }) => {
      stdout.write("x".repeat(200_000));
      exit(0);
      return {
        closed: Promise.resolve().then(() => {
          stdout.write("last");
        }),
      };
    },
    { env: {}, stdout: stream, stderr: quiet },
  );

  expect(await host.closed).toBe(0);

  expect(bytes.join("")).toBe("x".repeat(200_000) + "last");
  stream.end();
});

test("the host grace timeout is the only hard stop", async () => {
  const finish = Promise.withResolvers();

  let hardStops = 0;

  const host = createMainHost(
    async ({ exit }) => {
      exit(0);
      return { closed: finish.promise };
    },
    {
      env: {},
      stdout: quiet,
      stderr: quiet,
      graceMs: 1,
      hardStop: () => {
        hardStops += 1;
        finish.resolve();
      },
    },
  );

  expect(await host.closed).toBe(0);

  expect(hardStops).toBe(1);
});

test("dev socket close waits for the registered command and its stdout fence", async () => {
  const { installDevServer, registerDevMain, finishDevMain } = await import("../lib/main-host.mjs");

  const events = [];

  const codes = [];

  const finish = Promise.withResolvers();

  const server = {
    close: async () => {
      events.push("socket.closed");
    },
  };
  installDevServer("proof-root", server, (code) => {
    codes.push(code);
  });

  const host = createMainHost(
    async ({ exit }) => {
      exit(64);
      return {
        closed: finish.promise.then(() => {
          events.push("app.closed");
        }),
      };
    },
    { env: {}, stdout: quiet, stderr: quiet },
  );
  registerDevMain("proof-root", host);

  await host.started;

  const closing = finishDevMain("proof-root", host);

  expect(events).toEqual([]);

  finish.resolve();

  await closing;

  expect(events).toEqual(["app.closed", "socket.closed"]);

  expect(codes).toEqual([64]);
});

test("repeated OS signals after exit cannot cut off cleanup or change its first code", () => {
  const url = new URL("../lib/main-host.mjs", import.meta.url).href;

  const script = `
    import { runMain } from ${JSON.stringify(url)};

    await runMain(async ({ exit, stdout }) => {
      exit(64, "usage");
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 5);
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
      return { closed: new Promise((resolve) => setTimeout(() => {
        stdout.write("cleanup finished\\n");
        resolve();
      }, 50)) };
    });
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });

  expect(result.error).toBeUndefined();

  expect(result.signal).toBeNull();

  expect(result.status).toBe(64);

  expect(result.stdout).toContain("cleanup finished");
});

test("graceMs is a full delay before hardStop", async () => {
  vi.useFakeTimers();

  const finish = Promise.withResolvers();

  const hardStop = vi.fn(() => finish.resolve());

  try {
    const host = createMainHost(
      async ({ exit }) => {
        exit(0);

        return { closed: finish.promise };
      },
      { env: {}, stdout: quiet, stderr: quiet, graceMs: 100, hardStop },
    );

    await host.started;

    await vi.advanceTimersByTimeAsync(99);

    expect(hardStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(hardStop).toHaveBeenCalledTimes(1);

    await host.closed;
  } finally {
    vi.useRealTimers();
  }
});

test("clean close clears grace timeout even after its deadline passes", async () => {
  vi.useFakeTimers();

  const hardStop = vi.fn();

  try {
    const host = createMainHost(
      async ({ exit }) => {
        exit(0);

        return { closed: Promise.resolve() };
      },
      { env: {}, stdout: quiet, stderr: quiet, graceMs: 100, hardStop },
    );

    expect(await host.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(101);

    expect(hardStop).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

for (const trial of ["exit error", "late exit error", "rethrow saved error"]) {
  test(`${trial} prints the error stack once and keeps the first code`, async () => {
    const error = new Error("proof exit reason");

    let errors = "";

    const host = createMainHost(
      async ({ exit }) => {
        if (trial === "late exit error") exit(143);
        exit(1, error);
        if (trial === "rethrow saved error") throw error;
        return { closed: Promise.resolve() };
      },
      {
        env: {},
        stdout: quiet,
        stderr: {
          write(chunk) {
            errors += chunk;
          },
        },
      },
    );

    const code = trial === "late exit error" ? 143 : 1;

    expect(await host.closed).toBe(code);

    expect(errors).toBe(
      `${trial === "late exit error" ? "after exit 143" : "command failed (exit 1)"}: ${error.stack}\n`,
    );
  });
}

test("abort reasons stay quiet and a repeated late reason prints once", async () => {
  const error = new Error("one late reason");

  let errors = "";

  const host = createMainHost(
    async ({ exit }) => {
      exit(143);
      exit(1, error);
      exit(1, error);
      throw error;
    },
    {
      env: {},
      stdout: quiet,
      stderr: {
        write(chunk) {
          errors += chunk;
        },
      },
    },
  );

  expect(await host.closed).toBe(143);

  expect(errors).toBe(`after exit 143: ${error.stack}\n`);
});

test("hung cleanup prints the exit reason before the hard stop", async () => {
  vi.useFakeTimers();
  const error = new Error("hung cleanup");
  let errors = "";
  const hardStop = vi.fn(() => {
    expect(errors).toBe(`command failed (exit 1): ${error.stack}\n`);
  });
  try {
    const host = createMainHost(
      async ({ exit }) => {
        exit(1, error);
        return { closed: new Promise(() => {}) };
      },
      {
        env: {},
        stdout: quiet,
        stderr: {
          write(text) {
            errors += text;
          },
        },
        graceMs: 100,
        hardStop,
      },
    );

    await host.started;
    expect(errors).toBe(`command failed (exit 1): ${error.stack}\n`);
    expect(hardStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(hardStop).toHaveBeenCalledTimes(1);
    expect(errors).toBe(`command failed (exit 1): ${error.stack}\n`);
  } finally {
    vi.useRealTimers();
  }
});

for (const code of [1, 65, 75]) {
  test(`typed exit ${code} keeps the useful error detail`, async () => {
    const error = Object.assign(new Error("bad input"), {
      kind: "BadInput",
      payload: { reason: "CSV row 5: wrong cell count" },
    });
    let errors = "";
    const host = createMainHost(
      async ({ exit }) => {
        exit(code, error);
        return { closed: Promise.resolve() };
      },
      {
        env: {},
        stdout: quiet,
        stderr: {
          write(text) {
            errors += text;
          },
        },
      },
    );
    expect(await host.closed).toBe(code);

    const detail = code === 1 ? error.stack : `${error.kind}: ${JSON.stringify(error.payload)}`;
    expect(errors).toBe(`command failed (exit ${code}): ${detail}\n`);
  });
}

test("a command AbortError is printed", async () => {
  const error = new DOMException("app failed", "AbortError");
  let errors = "";
  const host = createMainHost(
    async ({ exit }) => {
      exit(1, error);
      return { closed: Promise.resolve() };
    },
    {
      env: {},
      stdout: quiet,
      stderr: {
        write(text) {
          errors += text;
        },
      },
    },
  );
  expect(await host.closed).toBe(1);
  expect(errors).toBe(`command failed (exit 1): ${error.stack}\n`);
});

test("a plain main throw is printed once", async () => {
  const error = new Error("main failed");
  let errors = "";
  const host = createMainHost(
    async () => {
      throw error;
    },
    {
      env: {},
      stdout: quiet,
      stderr: {
        write(text) {
          errors += text;
        },
      },
    },
  );
  expect(await host.closed).toBe(1);
  expect(errors).toBe(`command failed (exit 1): ${error.stack}\n`);
});

test("different main and cleanup errors are both printed once", async () => {
  const error = new Error("start failed");
  const cleanup = new Error("cleanup failed");
  let errors = "";

  const host = createMainHost(async () => ({ closed: Promise.reject(cleanup) }), {
    env: {},
    stdout: quiet,
    stderr: {
      write(text) {
        errors += text;
      },
    },
    onStart() {
      throw error;
    },
  });
  expect(await host.closed).toBe(1);
  expect(errors).toBe(`command failed (exit 1): ${error.stack}\nafter exit 1: ${cleanup.stack}\n`);
});

for (const payloadKind of ["bigint", "cycle"]) {
  for (const reasonKind of ["error", "plain"]) {
    test(`exit never throws for ${payloadKind} payload on ${reasonKind} reason`, async () => {
      const payload = { value: 1n };
      if (payloadKind === "cycle") payload.value = payload;
      const reason = Object.assign(
        reasonKind === "error"
          ? new Error("bad data")
          : {
              toString() {
                return "plain bad data";
              },
            },
        {
          kind: "BadInput",
          payload,
        },
      );
      let errors = "";
      let returned = false;
      const host = createMainHost(
        async ({ exit }) => {
          expect(() => exit(65, reason)).not.toThrow();
          returned = true;
          return { closed: Promise.resolve() };
        },
        {
          env: {},
          stdout: quiet,
          stderr: {
            write(text) {
              errors += text;
            },
          },
        },
      );

      expect(await host.closed).toBe(65);
      expect(returned).toBe(true);
      expect(host.signal.reason).toBe(reason);
      expect(errors).toBe(`command failed (exit 65): ${reason.stack ?? String(reason)}\n`);
    });
  }
}

test("exit still aborts and joins when even the reason cannot be shown", async () => {
  const reason = {
    get stack() {
      throw new Error("bad stack");
    },
    toString() {
      throw new Error("bad string");
    },
  };
  let errors = "";
  let returned = false;
  const host = createMainHost(
    async ({ exit }) => {
      exit(1, reason);
      returned = true;
      return { closed: Promise.resolve() };
    },
    {
      env: {},
      stdout: quiet,
      stderr: {
        write(text) {
          errors += text;
        },
      },
    },
  );

  expect(await host.closed).toBe(1);
  expect(returned).toBe(true);
  expect(host.signal.aborted).toBe(true);
  expect(errors).toBe("command failed (exit 1): Unprintable command failure\n");
});

test("exit still aborts and joins when stderr write throws", async () => {
  let returned = false;
  const host = createMainHost(
    async ({ exit }) => {
      exit(1, new Error("failure"));
      returned = true;
      return { closed: Promise.resolve() };
    },
    {
      env: {},
      stdout: quiet,
      stderr: {
        write() {
          throw new Error("broken stream");
        },
      },
    },
  );

  expect(await host.closed).toBe(1);
  expect(returned).toBe(true);
  expect(host.signal.aborted).toBe(true);
});
