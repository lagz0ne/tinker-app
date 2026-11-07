import { afterEach, expect, test } from "bun:test";

import { createScope, operation, resource, tag } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { callInput, hook } from "~/components/protocol";
import type { Reply } from "~/components/protocol";
import { channel, rpc } from "~/components/rpc";

// The lifecycle's hooks on rpc, both sides, one test per invariant of the work item (L1..L17,
// L20; L18 and L19 are remoteData's, and remoteData still runs on middleware). Each hook is a
// plain operation: `onStart` answers `{ meta, tags, context }` or refuses, `onError` recovers,
// refuses or lets the error stand, and only the work runs again on a fault `retry` names.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** The caller: what an `onStart` hook binds for the implementation, as `signedIn` does. */
const user = tag<string>({ label: "user" });

const api = rpc({
  echo: { input: z.object({ n: z.number() }), output: z.object({ n: z.number() }) },
  who: { input: z.null(), output: z.string() },
  fail: { input: z.null(), output: z.string() },
  tick: { input: z.null(), output: z.number(), mode: "stream" },
});

type Config = Parameters<typeof api>[0];

/** The server's implementations, complete: a test overrides the key it is about. */
const here = {
  echo: operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => input,
  }),
  who: operation({
    label: "who.do",
    input: z.null(),
    depends: { me: user.required },
    run: ({ me }) => me,
  }),
  fail: operation({
    label: "fail.do",
    input: z.null(),
    run: (): string => {
      throw new Error("boom");
    },
  }),
  tick: operation({
    label: "tick.do",
    input: z.null(),
    depends: { out: channel.required },
    run: ({ out }) => out.send(1),
  }),
};

/** A server scope that implements the keys here, and a client scope that calls them. */
async function pair(server: Config, client: Config, observe?: Observe.Config) {
  const impl = createScope({
    ...(observe ? { observe } : {}),
    capsules: [api(server), memory.server({ services: [api] })],
  });
  await impl.ready;
  const callers = createScope({
    capsules: [memory.client({ peer: impl }), api(client)],
  });
  await callers.ready;
  closers.push(
    () => callers.close(),
    () => impl.close(),
  );

  return { server: impl, client: callers };
}

const failure = (error: unknown) => (api.fault.is(error) ? [error.fault, error.payload] : null);

test("L1: an onStart that refuses stops the call: no implementation, refused, no onError", async () => {
  let ran = 0;
  let errors = 0;
  let seen: unknown = null;
  const no = operation({
    label: "no",
    input: hook.start,
    run: async (_, { input }) => input.refuse({ signIn: true }),
  });
  const count = operation({
    label: "count.errors",
    input: hook.error,
    run: () => void (errors += 1),
  });
  const finishes = operation({
    label: "see.outcome",
    input: hook.finish,
    run: (_, { input }) => void (seen = input.outcome),
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => (ran++, input),
  });
  const { client } = await pair(
    { implement: { ...here, echo: impl }, onStart: [no], onError: [count], onFinish: [finishes] },
    { remote: memory.client },
  );

  const error = await client.run(api.echo, { input: { n: 1 } }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(api.fault.is(error)).toBe(true);
  expect(failure(error)).toEqual(["refused", { signIn: true }]);
  expect(ran).toBe(0);
  expect(errors).toBe(0);
  expect(seen).toEqual({ kind: "refused", payload: { signIn: true } });
});

test("L2: an onStart binds tags for the implementation", async () => {
  const ann = operation({
    label: "bind.ann",
    input: hook.start,
    run: async () => ({ tags: [user("ann")] }),
  });
  const impl = operation({
    label: "who.do",
    input: z.null(),
    depends: { me: user.required },
    run: ({ me }) => me,
  });
  const { client } = await pair(
    { implement: { ...here, who: impl }, onStart: [ann] },
    { remote: memory.client },
  );

  expect(await client.run(api.who, { input: null })).toBe("ann");
});

test("L3: onStart answers merge into the context the later hooks read", async () => {
  let seen: unknown = null;
  const first = operation({
    label: "start.t0",
    input: hook.start,
    run: async () => ({ context: { t0: 5 } }),
  });
  const second = operation({
    label: "start.u",
    input: hook.start,
    run: async () => ({ context: { u: 1 } }),
  });
  const finishes = operation({
    label: "see.context",
    input: hook.finish,
    run: (_, { input }) => void (seen = input.context),
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => input,
  });
  const { client } = await pair(
    { implement: { ...here, echo: impl }, onStart: [first, second], onFinish: [finishes] },
    { remote: memory.client },
  );

  await client.run(api.echo, { input: { n: 1 } });

  expect(seen).toEqual({ t0: 5, u: 1 });
});

test("L4: a client onStart's meta reaches the server's hooks", async () => {
  let seen: string | undefined;
  const clientStart = operation({
    label: "start.meta",
    input: hook.start,
    run: async () => ({ meta: { "x-a": "1" } }),
  });
  const serverStart = operation({
    label: "server.start",
    input: hook.start,
    run: (_, { input }) => void (seen = input.meta["x-a"]),
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => input,
  });
  const { client } = await pair(
    { implement: { ...here, echo: impl }, onStart: [serverStart] },
    { remote: memory.client, onStart: [clientStart] },
  );

  await client.run(api.echo, { input: { n: 1 } });

  expect(seen).toBe("1");
});

test("L5: onSuccess chains: a value the first answers is the output the second reads", async () => {
  let second: unknown = null;
  const double = operation({
    label: "success.double",
    input: hook.success,
    run: async (_, { input }) => ({ n: Object(input.output).n * 2 }),
  });
  const see = operation({
    label: "success.see",
    input: hook.success,
    run: (_, { input }) => void (second = input.output),
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: () => ({ n: 1 }),
  });
  const { client } = await pair(
    { implement: { ...here, echo: impl }, onSuccess: [double, see] },
    { remote: memory.client },
  );

  expect(await client.run(api.echo, { input: { n: 1 } })).toEqual({ n: 2 });
  expect(second).toEqual({ n: 2 });
});

test("L6: a Core raise on the server becomes the payload an onError refuses with", async () => {
  const refusedAsFault = operation({
    label: "refusedAsFault",
    input: hook.error,
    run: async (_, { input }) =>
      input.refuse({ kind: Object(input.error).kind, message: Object(input.error).message }),
  });
  const impl = operation({
    label: "fail.do",
    input: z.null(),
    run: (_deps, { raise }): string => raise("Refused", { why: "not now" }),
  });
  const { client } = await pair(
    { implement: { ...here, fail: impl }, onError: [refusedAsFault] },
    { remote: memory.client },
  );

  const error = await client.run(api.fail, { input: null }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(failure(error)?.at(0)).toBe("refused");
  expect(failure(error)?.at(1)).toMatchObject({ kind: "Refused" });
});

test("L7: onError recovers with an output; a value that does not fit is failed", async () => {
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (): { n: number } => {
      throw new Error("half written");
    },
  });
  const recovers = operation({
    label: "recover.good",
    input: hook.error,
    run: async () => ({ n: 4 }),
  });
  const misses = operation({
    label: "recover.bad",
    input: hook.error,
    run: async () => ({ n: "four" }),
  });
  const good = await pair(
    { implement: { ...here, echo: impl }, onError: [recovers] },
    { remote: memory.client },
  );
  const bad = await pair(
    { implement: { ...here, echo: impl }, onError: [misses] },
    { remote: memory.client },
  );

  expect(await good.client.run(api.echo, { input: { n: 1 } })).toEqual({ n: 4 });
  const error = await bad.client.run(api.echo, { input: { n: 1 } }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(failure(error)).toEqual(["failed", {}]);
});

test("L8: an onError that answers nothing lets the error stand: failed, its cause only in the log", async () => {
  const lines: string[] = [];
  const impl = operation({
    label: "fail.do",
    input: z.null(),
    run: (): string => {
      throw new Error("db password is hunter2");
    },
  });
  const pass = operation({
    label: "pass.error",
    input: hook.error,
    run: () => undefined,
  });
  const { client } = await pair(
    { implement: { ...here, fail: impl }, onError: [pass] },
    { remote: memory.client },
    { log: (line) => void lines.push(`${line.message} ${JSON.stringify(line.attributes)}`) },
  );

  const error = await client.run(api.fail, { input: null }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(failure(error)).toEqual(["failed", {}]);
  expect(JSON.stringify(error)).not.toContain("hunter2");
  expect(lines.some((line) => line.includes("hunter2"))).toBe(true);
});

test("L9: retry { link: 2 } runs the call again until it answers", async () => {
  let calls = 0;
  const call = operation({
    label: "call.fake",
    input: callInput,
    run: async (): Promise<Reply> => {
      calls += 1;
      return calls < 3
        ? { ok: false, kind: "link", payload: {} }
        : { ok: true, value: { n: calls } };
    },
  });
  const { client } = await pair({ implement: here }, { remote: { call }, retry: { link: 2 } });

  expect(await client.run(api.echo, { input: { n: 1 } })).toEqual({ n: 3 });
  expect(calls).toBe(3);
});

test("L10: retry names link only: a failed call is not sent again", async () => {
  let ran = 0;
  const impl = operation({
    label: "fail.do",
    input: z.null(),
    run: (): string => {
      ran += 1;
      throw new Error("nope");
    },
  });
  const { client } = await pair(
    { implement: { ...here, fail: impl } },
    { remote: memory.client, retry: { link: 2 } },
  );

  const error = await client.run(api.fail, { input: null }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(failure(error)).toEqual(["failed", {}]);
  expect(ran).toBe(1);
});

test("L11: no retry config: a write that throws runs exactly once", async () => {
  let ran = 0;
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (): { n: number } => {
      ran += 1;
      throw new Error("write half done");
    },
  });
  const { client } = await pair({ implement: { ...here, echo: impl } }, { remote: memory.client });

  await client.run(api.echo, { input: { n: 1 } }).catch(() => undefined);

  expect(ran).toBe(1);
});

test("L12: no run again once the call's signal aborts", async () => {
  let calls = 0;
  const call = operation({
    label: "call.fake",
    input: callInput,
    run: async (): Promise<Reply> => {
      calls += 1;
      await tick(20);
      return { ok: false, kind: "link", payload: {} };
    },
  });
  const { client } = await pair({ implement: here }, { remote: { call }, retry: { link: 5 } });

  await client
    .run(api.echo, { input: { n: 1 }, signal: AbortSignal.timeout(5) })
    .catch(() => undefined);

  expect(calls).toBe(1);
});

test("L13: a stream never runs again, even for a fault retry names", async () => {
  let ran = 0;
  const impl = operation({
    label: "tick.do",
    input: z.null(),
    run: (): void => {
      ran += 1;
      throw new Error("no stream");
    },
  });
  const { client } = await pair(
    { implement: { ...here, tick: impl }, retry: { failed: 3 } },
    { remote: memory.client },
  );

  const stream = await client.run(api.tick, { input: null });
  await (async () => {
    for await (const _ of stream) {
      // nothing: the stream fails
    }
  })().catch(() => undefined);

  expect(ran).toBe(1);
});

test("L14: an implement entry adds to, or replaces, the capsule's hooks and retry", async () => {
  const order: string[] = [];
  const cap = operation({
    label: "start.cap",
    input: hook.start,
    run: () => void order.push("cap"),
  });
  const entry = operation({
    label: "start.entry",
    input: hook.start,
    run: () => void order.push("entry"),
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => input,
  });
  const both = await pair(
    { implement: { ...here, echo: { run: impl, onStart: [entry] } }, onStart: [cap] },
    { remote: memory.client },
  );
  await both.client.run(api.echo, { input: { n: 1 } });
  expect(order).toEqual(["cap", "entry"]);

  order.length = 0;
  const alone = await pair(
    {
      implement: { ...here, echo: { run: impl, inherit: false, onStart: [entry] } },
      onStart: [cap],
    },
    { remote: memory.client },
  );
  await alone.client.run(api.echo, { input: { n: 1 } });
  expect(order).toEqual(["entry"]);

  // An entry's retry replaces the capsule's: the capsule would try 4 times, the entry does not.
  let runs = 0;
  const once = operation({
    label: "fail.once",
    input: z.object({ n: z.number() }),
    run: (): { n: number } => {
      runs += 1;
      throw new Error("still broken");
    },
  });
  const replaced = await pair(
    { implement: { ...here, echo: { run: once, retry: {} } }, retry: { failed: 3 } },
    { remote: memory.client },
  );
  await replaced.client.run(api.echo, { input: { n: 1 } }).catch(() => undefined);
  expect(runs).toBe(1);

  // And the entry's own retry is the one that runs the work again.
  runs = 0;
  const then = operation({
    label: "fail.then",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => {
      runs += 1;
      if (runs === 1) throw new Error("once");
      return input;
    },
  });
  const entryRetry = await pair(
    { implement: { ...here, echo: { run: then, retry: { failed: 1 } } } },
    { remote: memory.client },
  );
  expect(await entryRetry.client.run(api.echo, { input: { n: 2 } })).toEqual({ n: 2 });
  expect(runs).toBe(2);
});

test("L15: a throw from an onStart goes to onError", async () => {
  let seen: unknown = null;
  const breaks = operation({
    label: "start.breaks",
    input: hook.start,
    run: (): never => {
      throw new Error("start broke");
    },
  });
  const sees = operation({
    label: "error.see",
    input: hook.error,
    run: (_, { input }) => void (seen = String(Object(input.error).message)),
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => input,
  });
  const { client } = await pair(
    { implement: { ...here, echo: impl }, onStart: [breaks], onError: [sees] },
    { remote: memory.client },
  );

  await client.run(api.echo, { input: { n: 1 } }).catch(() => undefined);

  expect(seen).toBe("start broke");
});

test("L16: a throw from onFinish is the caller's throw here, and failed over the wire", async () => {
  const finishes = operation({
    label: "finish.breaks",
    input: hook.finish,
    run: (): never => {
      throw new Error("finish broke");
    },
  });
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    run: (_deps, { input }) => input,
  });
  const { server, client } = await pair(
    { implement: { ...here, echo: impl }, onFinish: [finishes] },
    { remote: memory.client },
  );

  const inProcess = await server.run(api.echo, { input: { n: 1 } }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(String(Object(inProcess).message)).toBe("finish broke");

  const there = await client.run(api.echo, { input: { n: 1 } }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(failure(there)).toEqual(["failed", {}]);
});

test("L17: an implement retry runs the work in a fresh layer: one rollback, then a commit", async () => {
  const ends: string[] = [];
  const transaction = resource({
    label: "transaction",
    target: "session",
    factory: (_deps, { defer }) => {
      defer((end) => void ends.push(end.status));
      return {};
    },
  });
  let runs = 0;
  const impl = operation({
    label: "echo.do",
    input: z.object({ n: z.number() }),
    depends: { tx: transaction },
    run: (_deps, { input }) => {
      runs += 1;
      if (runs === 1) throw new Error("roll this back");
      return input;
    },
  });
  const { client } = await pair(
    { implement: { ...here, echo: impl }, retry: { failed: 1 } },
    { remote: memory.client },
  );

  expect(await client.run(api.echo, { input: { n: 3 } })).toEqual({ n: 3 });
  expect(runs).toBe(2);
  expect(ends).toEqual(["failed", "success"]);
});

test("L20: onError cannot recover a stream: the stream is failed, and the log says why", async () => {
  const lines: string[] = [];
  const impl = operation({
    label: "tick.do",
    input: z.null(),
    run: (): void => {
      throw new Error("no stream");
    },
  });
  const recovers = operation({
    label: "recover.number",
    input: hook.error,
    run: async () => 5,
  });
  const { client } = await pair(
    { implement: { ...here, tick: impl }, onError: [recovers] },
    { remote: memory.client },
    { log: (line) => void lines.push(`${line.message} ${JSON.stringify(line.attributes)}`) },
  );

  const stream = await client.run(api.tick, { input: null });
  const error = await (async () => {
    for await (const _ of stream) {
      // nothing: the stream fails
    }
  })().then(
    () => null,
    (e: unknown) => e,
  );

  expect(failure(error)).toEqual(["failed", {}]);
  expect(lines.some((line) => line.includes("onError cannot recover a stream"))).toBe(true);
});
