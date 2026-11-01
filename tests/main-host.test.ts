import { afterEach, expect, mock, spyOn, test } from "bun:test";

import type { MainClosed, MainContext } from "~/base/main";
import { createMainHost, runMain } from "~/base/main-host";

// The command host in process, with fake streams: each case drives one rule of
// tinker/base/main-host.ts and reads the code, the printed lines, and the host's own signal.
// Ported from the Hedl app's tests/main-host.test.ts, on bun:test.

type Closed = { closed: MainClosed };
type WriteDone = (error?: Error | null) => void;

/** A stream the host reads like a Node one: it records each write and answers its callback. */
const stream = (options: { fail?: object; destroyed?: boolean; isTTY?: boolean } = {}) => {
  const chunks: string[] = [];

  return {
    chunks,
    writable: true,
    destroyed: options.destroyed,
    isTTY: options.isTTY,
    write(chunk: string, done?: WriteDone) {
      chunks.push(chunk);
      done?.(options.fail ? Object.assign(new Error("write failed"), options.fail) : null);
      return true;
    },
    text: () => chunks.join(""),
  };
};

/** A write-only stream: no `writable` flag, so the host does not fence it. */
const plain = () => {
  let text = "";

  return {
    write(chunk: string) {
      text += chunk;
    },
    text: () => text,
  };
};

const done: Closed = { closed: Promise.resolve() };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls a check every 5 ms until it passes, for at most a second. */
const until = async (check: () => void) => {
  for (const started = Date.now(); ; await wait(5)) {
    try {
      return check();
    } catch (error) {
      if (Date.now() - started > 1000) throw error;
    }
  }
};

const host = (
  main: (ctx: MainContext) => Promise<Closed>,
  options: Partial<Parameters<typeof createMainHost>[1]> = {},
) => {
  const stderr = plain();
  const hardStop = mock();
  const run = createMainHost(main, {
    env: {},
    stdout: plain(),
    stderr,
    hardStop,
    graceMs: 20,
    ...options,
  });

  return { ...run, stderr, hardStop };
};

afterEach(() => {
  mock.restore();
});

test("a command that ends clean exits 0 and prints nothing", async () => {
  const run = host(async () => ({ closed: Promise.resolve([{ status: "success" as const }]) }));

  expect(await run.closed).toBe(0);
  expect(run.stderr.text()).toBe("");
});

test("a command's exit 0 with a reason prints nothing", async () => {
  const run = host(async ({ exit }) => {
    exit(0, new Error("done early"));
    return done;
  });

  expect(await run.closed).toBe(0);
  expect(run.stderr.text()).toBe("");
});

test("the first exit code wins; a later reason prints once, as late", async () => {
  const first = Object.assign(new Error("first"), { stack: "first stack" });
  const second = Object.assign(new Error("second"), { stack: "second stack" });
  const run = host(async ({ exit }) => {
    exit(2, first);
    exit(3, second);
    exit(4, second);
    exit(5, first);
    return done;
  });

  expect(await run.closed).toBe(2);
  expect(run.stderr.text()).toBe(
    "command failed (exit 2): first stack\nafter exit 2: second stack\n",
  );
});

test("an exit 0 reason given again with a failing code stays quiet", async () => {
  const reason = new Error("same");
  const run = host(async ({ exit }) => {
    exit(0, reason);
    exit(1, reason);
    return done;
  });

  expect(await run.closed).toBe(0);
  expect(run.stderr.text()).toBe("");
});

test("a failure with a kind and a payload prints both, but never on exit 1", async () => {
  const failure = { kind: "MissingConfig", payload: { key: "x" }, stack: "config stack" };
  const two = host(async ({ exit }) => {
    exit(2, failure);
    return done;
  });
  const one = host(async ({ exit }) => {
    exit(1, failure);
    return done;
  });

  expect(await two.closed).toBe(2);
  expect(two.stderr.text()).toBe('command failed (exit 2): MissingConfig: {"key":"x"}\n');
  expect(await one.closed).toBe(1);
  expect(one.stderr.text()).toBe("command failed (exit 1): config stack\n");
});

test("a payload with no kind prints the stack", async () => {
  const run = host(async ({ exit }) => {
    exit(2, { payload: { key: "x" }, stack: "payload stack" });
    return done;
  });

  expect(await run.closed).toBe(2);
  expect(run.stderr.text()).toBe("command failed (exit 2): payload stack\n");
});

test("a payload that JSON cannot print falls back to the stack, then to a fixed line", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const withStack = host(async ({ exit }) => {
    exit(2, { kind: "Odd", payload: { big: 1n }, stack: "odd stack" });
    return done;
  });
  const bare = Object.assign(Object.create(null), { kind: "Odd", payload: cyclic });
  const unprintable = host(async ({ exit }) => {
    exit(2, bare);
    return done;
  });

  expect(await withStack.closed).toBe(2);
  expect(withStack.stderr.text()).toBe("command failed (exit 2): odd stack\n");
  expect(await unprintable.closed).toBe(2);
  expect(unprintable.stderr.text()).toBe("command failed (exit 2): Unprintable command failure\n");
});

test("a host stop with no reason aborts with its own reason, which never prints", async () => {
  let seen: unknown;
  const run = host(async ({ signal }) => ({
    closed: new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => {
        seen = signal.reason;
        resolve();
      }),
    ),
  }));
  await run.started;

  run.stop(130);

  expect(await run.closed).toBe(130);
  expect(seen).toBeInstanceOf(DOMException);
  expect(seen).toMatchObject({ name: "AbortError", message: "Command stopped" });
  expect(run.signal.reason).toBe(seen);
  expect(run.stderr.text()).toBe("");
});

test("a host stop's signal reason never prints; a command's Error reason does", async () => {
  const signalled = host(async ({ signal }) => ({
    closed: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  }));
  await signalled.started;
  signalled.stop(143, new DOMException("SIGTERM", "AbortError"));

  expect(await signalled.closed).toBe(143);
  expect(signalled.stderr.text()).toBe("");

  const failed = host(async ({ signal }) => ({
    closed: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  }));
  await failed.started;
  failed.stop(2, Object.assign(new Error("own"), { stack: "own stack" }));

  expect(await failed.closed).toBe(2);
  expect(failed.stderr.text()).toBe("command failed (exit 2): own stack\n");
});

test("onStart runs once the command returned, and not when it already stopped", async () => {
  const onStart = mock();
  const running = host(async () => done, { onStart });

  expect(await running.closed).toBe(0);
  expect(onStart).toHaveBeenCalledTimes(1);
  const [call] = onStart.mock.calls;
  expect(call?.[0]).toBe(done);
  expect(call?.[1]).toBe(running.signal);

  const stopped = mock();
  const exited = host(
    async ({ exit }) => {
      exit(3);
      return done;
    },
    { onStart: stopped },
  );

  expect(await exited.closed).toBe(3);
  expect(stopped).not.toHaveBeenCalled();
});

test("a failed root or a teardown error exits 1 with the first error", async () => {
  const failure = Object.assign(new Error("root"), { stack: "root stack" });
  const teardown = Object.assign(new Error("teardown"), { stack: "teardown stack" });
  const failed = host(async () => ({
    closed: Promise.resolve([
      { status: "failed" as const, error: failure },
      { status: "success" as const, teardownErrors: [teardown] },
    ]),
  }));
  const tornDown = host(async () => ({
    closed: Promise.resolve({ status: "success" as const, teardownErrors: [teardown] }),
  }));
  const clean = host(async () => ({
    closed: Promise.resolve([{ status: "success" as const }, { status: "success" as const }]),
  }));

  expect(await failed.closed).toBe(1);
  expect(failed.stderr.text()).toBe("command failed (exit 1): root stack\n");
  expect(await tornDown.closed).toBe(1);
  expect(tornDown.stderr.text()).toBe("command failed (exit 1): teardown stack\n");
  expect(await clean.closed).toBe(0);
  expect(clean.stderr.text()).toBe("");
});

test("a command that returns no closed promise exits 1 and says so", async () => {
  const noClosed = host(async () => ({}) as Closed);

  expect(await noClosed.closed).toBe(1);
  expect(noClosed.stderr.text()).toMatch(
    /^command failed \(exit 1\): TypeError: main must return closed\n/,
  );
});

test("an onStart throw exits 1, and a different close error prints after it", async () => {
  const started = Object.assign(new Error("start"), { stack: "start stack" });
  const cleanup = Object.assign(new Error("cleanup"), { stack: "cleanup stack" });
  const run = host(async () => ({ closed: Promise.reject(cleanup) }), {
    onStart: () => {
      throw started;
    },
  });

  expect(await run.closed).toBe(1);
  expect(run.stderr.text()).toBe(
    "command failed (exit 1): start stack\nafter exit 1: cleanup stack\n",
  );

  const same = host(async () => ({ closed: Promise.reject(started) }), {
    onStart: () => {
      throw started;
    },
  });

  expect(await same.closed).toBe(1);
  expect(same.stderr.text()).toBe("command failed (exit 1): start stack\n");
});

test("after a command's exit, a close error that is not its reason prints late", async () => {
  const reason = Object.assign(new Error("reason"), { stack: "reason stack" });
  const other = Object.assign(new Error("other"), { stack: "other stack" });
  const run = host(async ({ exit }) => {
    exit(2, reason);
    return { closed: Promise.reject(other) };
  });

  expect(await run.closed).toBe(2);
  expect(run.stderr.text()).toBe(
    "command failed (exit 2): reason stack\nafter exit 2: other stack\n",
  );

  const own = host(async ({ exit }) => {
    exit(2, reason);
    return { closed: Promise.reject(reason) };
  });

  expect(await own.closed).toBe(2);
  expect(own.stderr.text()).toBe("command failed (exit 2): reason stack\n");
});

test("a startup throw exits 78 for a config error or a bad URL, else 1", async () => {
  const kinds = ["MissingTag", "MissingConfig", "DataValidationFailed"];
  for (const kind of kinds) {
    const run = host(async () => {
      throw { kind, payload: { label: "x" } };
    });

    expect(await run.closed).toBe(78);
    expect(run.stderr.text()).toBe(`command failed (exit 78): ${kind}: {"label":"x"}\n`);
  }

  const url = host(async () => {
    new URL("not a url");
    return done;
  });
  expect(await url.closed).toBe(78);

  const other = host(async () => {
    throw Object.assign(new Error("boom"), { stack: "boom stack" });
  });
  expect(await other.closed).toBe(1);
  expect(other.stderr.text()).toBe("command failed (exit 1): boom stack\n");
});

test("close fences each stream with an empty write", async () => {
  const stdout = stream();
  const stderr = stream();
  const run = host(
    async (ctx) => {
      ctx.stdout.write("out\n");
      return done;
    },
    { stdout, stderr },
  );

  expect(await run.closed).toBe(0);
  expect(stdout.chunks).toEqual(["out\n", ""]);
  expect(stderr.chunks).toEqual([""]);

  const gone = stream({ destroyed: true });
  const skipped = host(async () => done, { stdout: gone, stderr: stream() });

  expect(await skipped.closed).toBe(0);
  expect(gone.chunks).toEqual([]);
});

test("a gone reader is no failure; any other write error exits 1", async () => {
  const code = async (fail: object, isTTY?: boolean) =>
    await host(async () => done, { stdout: stream({ fail, isTTY }), stderr: stream() }).closed;

  expect(await code({ code: "EPIPE" })).toBe(0);
  expect(await code({ code: "EIO" }, true)).toBe(0);
  expect(await code({ code: "EIO" }, false)).toBe(1);
  expect(await code({ code: "ENOSPC" })).toBe(1);
});

test("close clears the grace timer, also after a second stop", async () => {
  const run = host(async ({ exit }) => {
    exit(1);
    exit(2);
    return done;
  });

  expect(await run.closed).toBe(1);
  await wait(60);
  expect(run.hardStop).not.toHaveBeenCalled();
});

test("a stop after close prints as late and starts no grace timer", async () => {
  const run = host(async () => done);

  expect(await run.closed).toBe(0);
  run.stop(2, Object.assign(new Error("late"), { stack: "late stack" }));
  await wait(60);

  expect(run.stderr.text()).toBe("after exit 0: late stack\n");
  expect(run.hardStop).not.toHaveBeenCalled();
});

test("a command that does not close within grace gets the hard stop", async () => {
  let release = () => {};
  const run = host(async ({ exit }) => {
    exit(1);
    return { closed: new Promise<void>((resolve) => (release = resolve)) };
  });

  await until(() => expect(run.hardStop).toHaveBeenCalledTimes(1));
  release();
  expect(await run.closed).toBe(1);
});

test("the default hard stop kills the process with SIGKILL", async () => {
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  let release = () => {};
  const run = createMainHost(
    async ({ exit }) => {
      exit(1);
      return { closed: new Promise<void>((resolve) => (release = resolve)) };
    },
    { env: {}, stdout: plain(), stderr: plain(), graceMs: 1 },
  );

  await until(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL"));
  release();
  expect(await run.closed).toBe(1);
});

/**
 * Run `runMain` with fake streams, then put back the process exit code. Bun keeps a code that is
 * set back to undefined, so `bun test` would exit with it: put back 0 instead.
 */
const runIn = async (main: (ctx: MainContext) => Promise<Closed>, options = {}) => {
  const exitCode = process.exitCode;
  try {
    const code = await runMain(main, options);
    return { code, exitCode: process.exitCode };
  } finally {
    process.exitCode = exitCode ?? 0;
  }
};

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const listeners = () => signals.map((name) => process.listeners(name).length);

test("runMain gives the command the process inputs and sets the exit code", async () => {
  let ctx: MainContext | undefined;
  const { code, exitCode } = await runIn(
    async (given) => {
      ctx = given;
      given.exit(3);
      return done;
    },
    { stdout: plain(), stderr: plain() },
  );

  expect(code).toBe(3);
  expect(exitCode).toBe(3);
  expect(ctx?.env).toBe(process.env);
  expect(ctx?.args).toEqual(process.argv.slice(2));
  expect(ctx?.cwd).toBe(process.cwd());
});

test("runMain stops the command on SIGHUP, SIGINT and SIGTERM, then drops its handlers", async () => {
  const before = listeners();
  for (const [index, name] of signals.entries()) {
    const added: (() => void)[] = [];
    const running = runIn(
      async ({ signal }) => {
        added.push(...(process.listeners(name).slice(before[index]) as (() => void)[]));
        return {
          closed: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
        };
      },
      { stdout: plain(), stderr: plain() },
    );
    await until(() => expect(added).toHaveLength(1));
    expect(listeners()).toEqual(before.map((count) => count + 1));

    for (const handler of added) handler();

    expect((await running).code).toBe({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[name]);
    expect(listeners()).toEqual(before);
  }
});

test("runMain ignores a gone reader on its streams and rethrows any other stream error", async () => {
  const handlers = new Map<string, (error: unknown) => void>();
  const watched = (name: string, isTTY?: boolean) => ({
    isTTY,
    write() {},
    on: mock((event: "error", listener: (error: unknown) => void) =>
      handlers.set(`${name} ${event}`, listener),
    ),
    off: mock(),
  });
  const stdout = watched("stdout");
  const stderr = watched("stderr");
  let quiet: ((error: unknown) => void) | undefined;
  await runIn(
    async () => {
      quiet = handlers.get("stdout error");
      return done;
    },
    { stdout, stderr },
  );

  expect(stdout.on).toHaveBeenCalledWith("error", quiet);
  expect(stderr.on).toHaveBeenCalledWith("error", quiet);
  expect(stdout.off).toHaveBeenCalledWith("error", quiet);
  expect(stderr.off).toHaveBeenCalledWith("error", quiet);
  expect(() => quiet?.({ code: "EPIPE" })).not.toThrow();
  const broken = { code: "EBADF" };
  expect(() => quiet?.(broken)).toThrow(expect.objectContaining(broken));
  // EIO is a closed terminal only when stdout is one.
  expect(() => quiet?.({ code: "EIO" })).toThrow();

  const tty = watched("tty", true);
  await runIn(async () => done, { stdout: tty, stderr: watched("tty-err") });
  expect(() => handlers.get("tty error")?.({ code: "EIO" })).not.toThrow();
  expect(() => handlers.get("tty error")?.({ code: "EBADF" })).toThrow();
});

test("runMain runs on streams that cannot report errors", async () => {
  const { code } = await runIn(async () => done, { stdout: plain(), stderr: plain() });

  expect(code).toBe(0);
});

test("a command run with no args gets none, and a null reason prints nothing", async () => {
  let args: readonly string[] | undefined;
  const run = host(async (ctx) => {
    args = ctx.args;
    ctx.exit(2, null);
    return done;
  });

  expect(await run.closed).toBe(2);
  expect(args).toEqual([]);
  expect(run.stderr.text()).toBe("");
});

test("after a command's exit, a startup throw that is not its reason prints late", async () => {
  const reason = Object.assign(new Error("reason"), { stack: "reason stack" });
  const other = Object.assign(new Error("other"), { stack: "other stack" });
  const run = host(async ({ exit }) => {
    exit(2, reason);
    throw other;
  });

  expect(await run.closed).toBe(2);
  expect(run.stderr.text()).toBe(
    "command failed (exit 2): reason stack\nafter exit 2: other stack\n",
  );

  const own = host(async ({ exit }) => {
    exit(2, reason);
    throw reason;
  });

  expect(await own.closed).toBe(2);
  expect(own.stderr.text()).toBe("command failed (exit 2): reason stack\n");
});

test("only an AbortError from the host is the host's own; another DOMException prints", async () => {
  const run = host(async ({ signal }) => ({
    closed: new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  }));
  await run.started;
  const clone = new DOMException("cannot clone", "DataCloneError");
  run.stop(2, clone);

  expect(await run.closed).toBe(2);
  expect(run.stderr.text()).toMatch(/^command failed \(exit 2\): .*cannot clone/);
});

test("on a terminal, only EIO is a gone reader; other write errors still exit 1", async () => {
  const run = host(async () => done, {
    stdout: stream({ fail: { code: "ENOSPC" }, isTTY: true }),
    stderr: stream(),
  });

  expect(await run.closed).toBe(1);
});
