import { createScope } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import {
  agentConfigDir,
  agentCredentials,
  agentMaxRunning,
  agentPath,
  agentSdk,
  agentTalk,
} from "~/components/agent-talk/index.server";
import type { TalkEvent, TurnResult } from "~/components/agent-talk/index.server";
import { agentFiles } from "~/components/agent-talk/modules.server";

import {
  abortError,
  assistant,
  compact,
  failure,
  fakeAgentSdk,
  hangs,
  init,
  notLoggedIn,
  reply,
  say,
  success,
  toolResult,
  usage,
} from "./agent-fake";
import type { FakeKit, FakeScript } from "./agent-fake";

const token = "sk-ant-oat01-SECRET-oauth-token";

const apiKey = "sk-ant-api03-SECRET-api-key";

const options = { model: "claude-haiku-5-5", tools: [], maxTurns: 1 };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function talkScope(
  fake: ReturnType<typeof fakeAgentSdk>,
  {
    credentials = { oauthToken: token } as { oauthToken: string } | { apiKey: string } | null,
    max = 3,
    logs = [] as Observe.Log[],
  } = {},
) {
  return createScope({
    clock: makeTestClock({ now: 1_000 }),
    tags: [
      ...(credentials ? [agentCredentials(credentials)] : []),
      agentConfigDir("/data/claude"),
      agentMaxRunning(max),
    ],
    presets: [preset(agentSdk, async () => fake.sdk), preset(agentFiles, async () => fake.files)],
    observe: { log: (entry) => logs.push(entry) },
  });
}

function recorder() {
  const events: TalkEvent[] = [];

  return { events, onEvent: (event: TalkEvent) => events.push(event) };
}

test("R5 a success result settles done; the stream maps 1:1 to talk events", async () => {
  const fake = fakeAgentSdk(async function* ({ session }: FakeKit) {
    yield init(session);
    yield* say(session, "msg_1", "Hello there");

    yield assistant(session, "msg_2", [
      { type: "text", text: "Whole reply" },
      { type: "tool_use", id: "toolu_1", name: "mcp__talk__note", input: { a: 1 } },
    ]);
    yield toolResult(session, "toolu_1", "Not done: no", true);
    yield compact(session, 56000, 9000);
    yield success(session, 0.75);
  });

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const { events, onEvent } = recorder();

    const result = await talk.run("a", { prompt: "hi", options, onEvent }).result;

    expect(result).toEqual({
      status: "done",
      sessionId: "session-1",
      costUsd: 0.75,
      usage,
      numTurns: 1,
      durationMs: 1200,
      denials: [],
    });

    const contextTokens = 2 + 1000 + 30 + 8;

    expect(events).toEqual([
      {
        type: "init",
        sessionId: "session-1",
        model: "claude-haiku-5-5",
        tools: ["WebSearch"],
        mcpServers: [{ name: "talk", status: "connected" }],
        claudeCodeVersion: "2.9.0",
        permissionMode: "dontAsk",
      },
      { type: "text-start", messageId: "msg_1" },
      { type: "text", messageId: "msg_1", delta: "Hello " },
      { type: "text", messageId: "msg_1", delta: "there" },
      { type: "usage", messageId: "msg_1", contextTokens, usage },
      { type: "text-end", messageId: "msg_1" },
      { type: "text-whole", messageId: "msg_2", text: "Whole reply" },
      { type: "tool-start", id: "toolu_1", name: "mcp__talk__note", input: { a: 1 } },
      { type: "usage", messageId: "msg_2", contextTokens, usage },
      { type: "tool-end", id: "toolu_1", isError: true, text: "Not done: no" },
      { type: "compact", preTokens: 56000, postTokens: 9000 },
    ]);
  } finally {
    await root.close();
  }
});

test("R5 the component fixes the safe options and the exact env; the OAuth token goes alone", async () => {
  const fake = fakeAgentSdk();

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    expect(fake.made).toEqual([["/data/claude/tmp", { recursive: true }]]);

    const appOptions = {
      ...options,
      systemPrompt: "Be brief.",
      allowedTools: ["mcp__talk__*"],
      disallowedTools: ["Bash"],
      effort: "low" as const,
      cwd: "/data/talk",
      resume: "s-old",
      settings: { disableClaudeAiConnectors: true },
    };

    await talk.run("a", { prompt: "hi", options: appOptions }).result;

    const [call] = fake.calls;

    expect(call!.prompt).toBe("hi");

    const { abortController, env, ...rest } = call!.options;

    expect(abortController).toBeInstanceOf(AbortController);

    expect(rest).toEqual({
      ...appOptions,
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      persistSession: true,
      includePartialMessages: true,
    });

    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/data/claude",
      CLAUDE_CONFIG_DIR: "/data/claude",
      TMPDIR: "/data/claude/tmp",
      LANG: "C.UTF-8",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_CODE_OAUTH_TOKEN: token,
    });
  } finally {
    await root.close();
  }
});

test("R5 an API key goes as ANTHROPIC_API_KEY alone, and agentPath sets PATH", async () => {
  const fake = fakeAgentSdk();

  const root = createScope({
    tags: [
      agentCredentials({ apiKey }),
      agentConfigDir("/data/claude"),
      agentPath("/opt/bin:/usr/bin"),
    ],
    presets: [preset(agentSdk, async () => fake.sdk), preset(agentFiles, async () => fake.files)],
  });

  try {
    const talk = await root.resolve(agentTalk);

    await talk.run("a", { prompt: "hi", options }).result;

    const env = fake.calls[0]!.options.env!;

    expect(env.ANTHROPIC_API_KEY).toBe(apiKey);

    expect(env.PATH).toBe("/opt/bin:/usr/bin");

    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);

    expect(Object.keys(env)).toHaveLength(13);
  } finally {
    await root.close();
  }
});

test("R5 error_max_turns fails max-turns; another error result fails claude", async () => {
  const fake = fakeAgentSdk(
    async function* ({ session }: FakeKit) {
      yield init(session);
      yield failure(session, "error_max_turns", []);
    },
    async function* ({ session }: FakeKit) {
      yield init(session);
      yield failure(session, "error_during_execution", ["overloaded"]);
    },
  );

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    expect(await talk.run("a", { prompt: "hi", options }).result).toMatchObject({
      status: "failed",
      error: "max-turns",
      sessionId: "session-1",
    });

    expect(await talk.run("a", { prompt: "hi", options }).result).toEqual({
      status: "failed",
      error: "claude",
      message: "overloaded",
      sessionId: "session-2",
    });
  } finally {
    await root.close();
  }
});

test("R5 an auth error fails not-signed-in and the later thrown exit code is ignored", async () => {
  const fake = fakeAgentSdk(notLoggedIn, async function* ({ session }: FakeKit) {
    yield init(session);
    throw new Error("API Error: 401 authentication_error");
  });

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    expect(await talk.run("a", { prompt: "hi", options }).result).toMatchObject({
      status: "failed",
      error: "not-signed-in",
      message: "Not logged in · Please run /login",
    });

    expect(await talk.run("a", { prompt: "hi", options }).result).toMatchObject({
      status: "failed",
      error: "not-signed-in",
    });
  } finally {
    await root.close();
  }
});

test("R5 a thrown error fails claude with its message", async () => {
  const fake = fakeAgentSdk(async function* ({ session }: FakeKit) {
    yield init(session);
    throw new Error("Claude Code process exited with code 2");
  });

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    expect(await talk.run("a", { prompt: "hi", options }).result).toEqual({
      status: "failed",
      error: "claude",
      message: "Claude Code process exited with code 2",
      sessionId: "session-1",
    });
  } finally {
    await root.close();
  }
});

test("R1 run on a closed scope returns closed and never calls query", async () => {
  const fake = fakeAgentSdk();

  const root = talkScope(fake);

  const talk = await root.resolve(agentTalk);

  await root.close();

  expect(await talk.run("a", { prompt: "hi", options }).result).toEqual({ status: "closed" });

  expect(fake.calls).toHaveLength(0);
});

test("R2 I4 one run per talk: a second run is busy at once and calls no query", async () => {
  const fake = fakeAgentSdk(hangs);

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const first = talk.run("a", { prompt: "one", options });

    await tick();

    expect(await talk.run("a", { prompt: "two", options }).result).toEqual({ status: "busy" });

    expect(fake.calls).toHaveLength(1);

    talk.stop("a");

    expect((await first.result).status).toBe("stopped");

    expect((await talk.run("a", { prompt: "three", options }).result).status).toBe("done");
  } finally {
    await root.close();
  }
});

test("R2 a waiting run also makes the talk busy", async () => {
  const fake = fakeAgentSdk(hangs);

  const root = talkScope(fake, { max: 1 });

  try {
    const talk = await root.resolve(agentTalk);

    const holder = talk.run("x", { prompt: "hold", options });

    const waiting = talk.run("a", { prompt: "wait", options });

    expect(await talk.run("a", { prompt: "again", options }).result).toEqual({ status: "busy" });

    talk.stop("a");

    talk.stop("x");

    expect((await waiting.result).status).toBe("stopped");

    expect((await holder.result).status).toBe("stopped");
  } finally {
    await root.close();
  }
});

test("R3 unbound credentials fail not-signed-in and call no query", async () => {
  const fake = fakeAgentSdk();

  const root = talkScope(fake, { credentials: null });

  try {
    const talk = await root.resolve(agentTalk);

    const result = await talk.run("a", { prompt: "hi", options }).result;

    expect(result).toMatchObject({ status: "failed", error: "not-signed-in" });

    expect(typeof (result as { message: string }).message).toBe("string");

    expect(fake.calls).toHaveLength(0);
  } finally {
    await root.close();
  }
});

test("R4 the cap: over agentMaxRunning a run waits in FIFO order with one waiting event", async () => {
  const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());

  const gated = (index: number): FakeScript =>
    async function* (kit) {
      yield init(kit.session);
      await kit.wait(gates[index]!.promise);
      yield success(kit.session);
    };

  const fake = fakeAgentSdk(gated(0), gated(1), gated(2));

  const root = talkScope(fake, { max: 1 });

  try {
    const talk = await root.resolve(agentTalk);

    const a = recorder();

    const b = recorder();

    const c = recorder();

    const runA = talk.run("a", { prompt: "a", options, onEvent: a.onEvent });

    const runB = talk.run("b", { prompt: "b", options, onEvent: b.onEvent });

    const runC = talk.run("c", { prompt: "c", options, onEvent: c.onEvent });

    await tick();

    expect(fake.calls.map((call) => call.prompt)).toEqual(["a"]);

    expect(a.events.filter((event) => event.type === "waiting")).toHaveLength(0);

    expect(b.events).toEqual([{ type: "waiting" }]);

    expect(c.events).toEqual([{ type: "waiting" }]);

    gates[0]!.resolve();

    expect((await runA.result).status).toBe("done");

    await tick();

    expect(fake.calls.map((call) => call.prompt)).toEqual(["a", "b"]);

    gates[1]!.resolve();

    gates[2]!.resolve();

    expect((await runB.result).status).toBe("done");

    expect((await runC.result).status).toBe("done");

    expect(fake.calls.map((call) => call.prompt)).toEqual(["a", "b", "c"]);

    expect(b.events.filter((event) => event.type === "waiting")).toHaveLength(1);
  } finally {
    await root.close();
  }
});

test("R4 at most agentMaxRunning queries run at once", async () => {
  const gate = Promise.withResolvers<void>();

  let running = 0;

  let peak = 0;

  const counted: FakeScript = async function* (kit) {
    running++;
    peak = Math.max(peak, running);
    try {
      yield init(kit.session);
      await kit.wait(gate.promise);
      yield success(kit.session);
    } finally {
      running--;
    }
  };

  const fake = fakeAgentSdk(...Array.from({ length: 5 }, () => counted));

  const root = talkScope(fake, { max: 2 });

  try {
    const talk = await root.resolve(agentTalk);

    const runs = ["a", "b", "c", "d", "e"].map((name) => talk.run(name, { prompt: name, options }));

    await tick();

    expect(fake.calls).toHaveLength(2);

    gate.resolve();

    const results = await Promise.all(runs.map((run) => run.result));

    expect(results.map((result) => result.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ]);

    expect(peak).toBe(2);
  } finally {
    await root.close();
  }
});

test("R6 a lost session emits session-lost and retries once without resume", async () => {
  const fake = fakeAgentSdk(async function* ({ session }: FakeKit) {
    yield init(session);
    yield failure(session, "error_during_execution", [
      "No conversation found with session ID: s-gone",
    ]);
  }, reply);

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const { events, onEvent } = recorder();

    const result = await talk.run("a", {
      prompt: "hi",
      options: { ...options, resume: "s-gone" },
      onEvent,
    }).result;

    expect(result).toMatchObject({ status: "done", sessionId: "session-2" });

    expect(fake.calls).toHaveLength(2);

    expect(fake.calls[0]!.options.resume).toBe("s-gone");

    expect("resume" in fake.calls[1]!.options).toBe(false);

    expect(fake.calls[1]!.prompt).toBe("hi");

    expect(events.filter((event) => event.type === "session-lost")).toHaveLength(1);

    expect(events.findIndex((event) => event.type === "session-lost")).toBe(1);
  } finally {
    await root.close();
  }
});

test("R6 the retry happens once; its result is the result", async () => {
  const lost: FakeScript = async function* ({ session }) {
    yield init(session);
    throw new Error("Session s-gone not found");
  };

  const fake = fakeAgentSdk(lost, lost, lost);

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const result = await talk.run("a", { prompt: "hi", options: { ...options, resume: "s-gone" } })
      .result;

    expect(result).toMatchObject({ status: "failed", error: "claude" });

    expect(fake.calls).toHaveLength(2);

    expect(await talk.run("b", { prompt: "hi", options }).result).toMatchObject({
      status: "failed",
      error: "claude",
    });

    expect(fake.calls, "no resume: no retry").toHaveLength(3);
  } finally {
    await root.close();
  }
});

test("R7 stop aborts a running run with its session id; a waiting run stops without a query", async () => {
  const fake = fakeAgentSdk(hangs);

  const root = talkScope(fake, { max: 1 });

  try {
    const talk = await root.resolve(agentTalk);

    const running = talk.run("a", { prompt: "a", options });

    const waiting = talk.run("b", { prompt: "b", options });

    await tick();

    talk.stop("b");

    expect(await waiting.result).toEqual({ status: "stopped" });

    expect(fake.calls).toHaveLength(1);

    talk.stop("a");

    expect(await running.result).toEqual({ status: "stopped", sessionId: "session-1" });

    expect(fake.calls[0]!.options.abortController!.signal.aborted).toBe(true);

    talk.stop("a");

    talk.stop("never");

    expect((await talk.run("a", { prompt: "again", options }).result).status).toBe("done");
  } finally {
    await root.close();
  }
});

test("R8 a throwing onEvent aborts that query and fails listener", async () => {
  const fake = fakeAgentSdk(hangs);

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    let calls = 0;

    const result = await talk.run("a", {
      prompt: "hi",
      options,
      onEvent: (event) => {
        calls++;
        if (event.type === "text-start") throw new Error("page gone");
      },
    }).result;

    expect(result).toEqual({
      status: "failed",
      error: "listener",
      message: "page gone",
      sessionId: "session-1",
    });

    expect(calls).toBe(2);

    expect(fake.calls[0]!.ended).toBe(true);
  } finally {
    await root.close();
  }
});

test("R9 no event reaches onEvent after stop or after the result settles", async () => {
  const late = Promise.withResolvers<void>();

  const fake = fakeAgentSdk(async function* ({ session, signal }: FakeKit) {
    yield init(session);
    // A stubborn SDK: it ignores the abort and still yields.
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    await late.promise;
    yield* say(session, "msg_9", "late text");
    yield success(session);
  });

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const { events, onEvent } = recorder();

    const run = talk.run("a", { prompt: "hi", options, onEvent });

    await tick();

    talk.stop("a");

    const seen = events.length;

    late.resolve();

    expect((await run.result).status).toBe("stopped");

    await tick();

    expect(events).toHaveLength(seen);
  } finally {
    await root.close();
  }
});

test("R10 every query is closed in a finally and the result settles after its loop ended", async () => {
  const fake = fakeAgentSdk(
    reply,
    notLoggedIn,
    async function* ({ session }: FakeKit) {
      yield init(session);
      throw abortError();
    },
    hangs,
    hangs,
  );

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const ended = async (run: { result: Promise<TurnResult> }) => {
      const result = await run.result;

      const call = fake.calls.at(-1)!;

      return { status: result.status, closed: call.closed, ended: call.ended };
    };

    expect(await ended(talk.run("a", { prompt: "1", options }))).toEqual({
      status: "done",
      closed: 1,
      ended: true,
    });

    expect(await ended(talk.run("a", { prompt: "2", options }))).toEqual({
      status: "failed",
      closed: 1,
      ended: true,
    });

    expect(await ended(talk.run("a", { prompt: "3", options }))).toEqual({
      status: "failed",
      closed: 1,
      ended: true,
    });

    const stopped = talk.run("a", { prompt: "4", options });

    await tick();

    talk.stop("a");

    expect(await ended(stopped)).toEqual({ status: "stopped", closed: 1, ended: true });

    const listener = talk.run("a", {
      prompt: "5",
      options,
      onEvent: () => {
        throw new Error("no");
      },
    });

    expect(await ended(listener)).toEqual({ status: "failed", closed: 1, ended: true });
  } finally {
    await root.close();
  }
});

for (const graceful of [true, false]) {
  test(`R11 I1 ${graceful ? "graceful" : "forced"} close ends a streaming run closed after its generator finally ran`, async () => {
    const fake = fakeAgentSdk(hangs, async function* ({ session, hang }: FakeKit) {
      yield init(session);
      try {
        await hang();
      } catch {
        // The SDK answers an abort with an error result, then the abort.
        yield failure(session, "error_during_execution", ["Request was aborted."]);
        throw abortError();
      }
    });

    const root = talkScope(fake, { max: 2 });

    const talk = await root.resolve(agentTalk);

    const first = recorder();

    const streaming = talk.run("a", { prompt: "a", options, onEvent: first.onEvent });

    const erroring = talk.run("b", { prompt: "b", options });

    const waiting = talk.run("c", { prompt: "c", options });

    await tick();

    expect(first.events.some((event) => event.type === "text")).toBe(true);

    expect(fake.calls).toHaveLength(2);

    const closed = await root.close({ graceful });

    expect(closed.status, "Core: a forced close settles cancelled").toBe(
      graceful ? "success" : "cancelled",
    );

    expect(fake.calls.map((call) => [call.ended, call.closed])).toEqual([
      [true, 1],
      [true, 1],
    ]);

    expect(fake.calls).toHaveLength(2);

    expect(await streaming.result).toEqual({ status: "closed", sessionId: "session-1" });

    expect(await erroring.result).toEqual({ status: "closed", sessionId: "session-2" });

    expect(await waiting.result).toEqual({ status: "closed" });
  });
}

test("R11 a run that settled done stays done after close", async () => {
  const fake = fakeAgentSdk();

  const root = talkScope(fake);

  const talk = await root.resolve(agentTalk);

  const run = talk.run("a", { prompt: "hi", options });

  expect((await run.result).status).toBe("done");

  await root.close();

  expect((await run.result).status).toBe("done");
});

test("I2 no run outlives its scope: after close no query runs and run returns closed", async () => {
  const fake = fakeAgentSdk(hangs);

  const root = talkScope(fake);

  const talk = await root.resolve(agentTalk);

  const run = talk.run("a", { prompt: "hi", options });

  await tick();

  await root.close();

  expect(fake.calls.every((call) => call.ended && call.closed === 1)).toBe(true);

  expect((await run.result).status).toBe("closed");

  expect((await talk.run("a", { prompt: "again", options }).result).status).toBe("closed");

  expect(fake.calls).toHaveLength(1);
});

test("I3 two talks never share state in one scope", async () => {
  const fake = fakeAgentSdk(hangs, async function* ({ session }: FakeKit) {
    yield init(session);
    yield* say(session, "msg_b", "for b");
    yield success(session);
  });

  const root = talkScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const a = recorder();

    const b = recorder();

    const runA = talk.run("a", { prompt: "a", options, onEvent: a.onEvent });

    const runB = talk.run("b", { prompt: "b", options, onEvent: b.onEvent });

    expect((await runB.result).status).toBe("done");

    talk.stop("a");

    expect(await runA.result).toEqual({ status: "stopped", sessionId: "session-1" });

    const text = (events: TalkEvent[]) =>
      events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");

    expect(text(a.events)).toBe("counting");

    expect(text(b.events)).toBe("for b");

    expect(a.events.some((event) => "messageId" in event && event.messageId === "msg_b")).toBe(
      false,
    );
  } finally {
    await root.close();
  }
});

test("I3 two scopes never share a run with the same talk id", async () => {
  const fakeOne = fakeAgentSdk(hangs);

  const fakeTwo = fakeAgentSdk(async function* (kit: FakeKit) {
    yield init(kit.session);
    await tick();
    yield success(kit.session);
  });

  const one = talkScope(fakeOne);

  const two = talkScope(fakeTwo);

  try {
    const talkOne = await one.resolve(agentTalk);

    const talkTwo = await two.resolve(agentTalk);

    const runOne = talkOne.run("a", { prompt: "one", options });

    const runTwo = talkTwo.run("a", { prompt: "two", options });

    await tick();

    await one.close();

    expect((await runOne.result).status).toBe("closed");

    expect((await runTwo.result).status).toBe("done");
  } finally {
    await one.close();
    await two.close();
  }
});

test("R15 credentials never leave: error text is redacted in results and logs", async () => {
  const logs: Observe.Log[] = [];

  const fake = fakeAgentSdk(
    async function* ({ session }: FakeKit) {
      yield init(session);
      yield failure(session, "error_during_execution", [
        `bad env CLAUDE_CODE_OAUTH_TOKEN=${token}`,
      ]);
    },
    async function* ({ session }: FakeKit) {
      yield init(session);
      yield* say(session, "msg_1", `echo ${token}`);
      yield toolResult(session, "toolu_1", `token ${token}`);
      throw new Error(`spawn failed with ${token}`);
    },
  );

  const root = talkScope(fake, { logs });

  try {
    const talk = await root.resolve(agentTalk);

    const { events, onEvent } = recorder();

    const first = await talk.run("a", { prompt: "hi", options, onEvent }).result;

    const second = await talk.run("a", { prompt: "hi", options, onEvent }).result;

    expect(first).toMatchObject({
      status: "failed",
      error: "claude",
      message: "bad env CLAUDE_CODE_OAUTH_TOKEN=[redacted]",
    });

    expect(second).toMatchObject({ status: "failed", message: "spawn failed with [redacted]" });

    const out = JSON.stringify({ first, second, events, logs });

    expect(out).not.toContain(token);

    expect(out).toContain("[redacted]");

    expect(logs.some((entry) => entry.attributes.talk === "a")).toBe(true);

    expect(JSON.stringify(logs)).not.toContain("CLAUDE_CONFIG_DIR");
  } finally {
    await root.close();
  }
});
