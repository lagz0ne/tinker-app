import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import {
  agentConfigDir,
  agentCredentials,
  agentMaxRunning,
  agentSdk,
  agentTalk,
} from "~/components/agent-talk/index.server";
import type { TalkEvent, TurnResult, WarmPlan } from "~/components/agent-talk/index.server";
import { agentFiles } from "~/components/agent-talk/modules.server";

import { fakeAgentSdk, failure, hangs, init, success } from "./agent-fake";
import type { FakeKit, FakeScript } from "./agent-fake";

const minute = 60_000;

const options = { model: "claude-haiku-5-5", tools: [], maxTurns: 1 };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function warmScope(fake: ReturnType<typeof fakeAgentSdk>, max = 3) {
  const clock = makeTestClock({ now: 0 });

  const root = createScope({
    clock,
    tags: [
      agentCredentials({ oauthToken: "sk-ant-oat01-SECRET" }),
      agentConfigDir("/data/claude"),
      agentMaxRunning(max),
    ],
    presets: [preset(agentSdk, () => fake.sdk), preset(agentFiles, () => fake.files)],
  });

  return { clock, root };
}

/** Moves the test clock in steps, letting each woken ping finish before the next step. */
async function advance(clock: ReturnType<typeof makeTestClock>, ms: number, step = minute) {
  for (let moved = 0; moved < ms; moved += step) {
    clock.advance(Math.min(step, ms - moved));
    await tick();
    await tick();
  }
}

const plan = (extra: Partial<WarmPlan> = {}): WarmPlan => ({
  options: { ...options, resume: "s-1" },
  prompt: "ping",
  everyMs: 50 * minute,
  untilMs: 180 * minute,
  ...extra,
});

test("R12 warm pings at 50, 100, 150 min, then ends with 3 pings at 200", async () => {
  const fake = fakeAgentSdk();

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const pinged: [number, TurnResult][] = [];

    const warm = talk.warm(
      "a",
      plan({ onPing: (result) => pinged.push([clock.currentTimeMillis(), result]) }),
    );

    let done: unknown;

    void warm.done.then((value) => (done = value));

    await advance(clock, 49 * minute);

    expect(fake.calls).toHaveLength(0);

    await advance(clock, 1 * minute);

    expect(fake.calls).toHaveLength(1);

    await advance(clock, 100 * minute);

    expect(pinged.map(([at]) => at / minute)).toEqual([50, 100, 150]);

    expect(pinged.every(([, result]) => result.status === "done")).toBe(true);

    expect(done).toBeUndefined();

    await advance(clock, 50 * minute);

    expect(await warm.done).toEqual({ status: "ended", pings: 3 });

    expect(fake.calls).toHaveLength(3);

    for (const call of fake.calls) {
      expect(call.prompt).toBe("ping");

      expect(call.options.resume).toBe("s-1");

      expect(call.options.permissionMode).toBe("dontAsk");
    }
  } finally {
    await root.close();
  }
});

test("R12 a fire skips while the talk has a run, then pings again", async () => {
  const gate = Promise.withResolvers<void>();

  const fake = fakeAgentSdk(async function* (kit: FakeKit) {
    yield init(kit.session);
    await kit.wait(gate.promise);
    yield success(kit.session);
  });

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const run = talk.run("a", { prompt: "long turn", options });

    let pings = 0;

    const warm = talk.warm("a", plan({ onPing: () => pings++ }));

    await advance(clock, 50 * minute);

    expect(fake.calls.map((call) => call.prompt)).toEqual(["long turn"]);

    gate.resolve();

    expect((await run.result).status).toBe("done");

    await advance(clock, 50 * minute);

    expect(fake.calls.map((call) => call.prompt)).toEqual(["long turn", "ping"]);

    expect(pings).toBe(1);

    talk.stop("a");

    expect(await warm.done).toEqual({ status: "stopped", pings: 1 });
  } finally {
    await root.close();
  }
});

test("R12 a ping that is not done ends the plan failed", async () => {
  const fake = fakeAgentSdk(async function* ({ session }: FakeKit) {
    yield init(session);
    yield failure(session, "error_during_execution", ["overloaded"]);
  });

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    let pinged = 0;

    const warm = talk.warm("a", plan({ onPing: () => pinged++ }));

    await advance(clock, 50 * minute);

    expect(await warm.done).toEqual({ status: "failed", pings: 0, message: "overloaded" });

    expect(pinged).toBe(0);
  } finally {
    await root.close();
  }
});

test("R12 a ping is quiet and takes a slot under the cap", async () => {
  const gate = Promise.withResolvers<void>();

  const fake = fakeAgentSdk(async function* (kit: FakeKit) {
    yield init(kit.session);
    await kit.wait(gate.promise);
    yield success(kit.session);
  });

  const { clock, root } = warmScope(fake, 1);

  try {
    const talk = await root.resolve(agentTalk);

    const warm = talk.warm("a", plan());

    await advance(clock, 50 * minute);

    expect(fake.calls).toHaveLength(1);

    const events: TalkEvent[] = [];

    const other = talk.run("b", { prompt: "b", options, onEvent: (event) => events.push(event) });

    await tick();

    expect(events).toEqual([{ type: "waiting" }]);

    expect(fake.calls).toHaveLength(1);

    gate.resolve();

    expect((await other.result).status).toBe("done");

    expect(fake.calls.map((call) => call.prompt)).toEqual(["ping", "b"]);

    talk.stop("a");

    expect(await warm.done).toEqual({ status: "stopped", pings: 1 });
  } finally {
    await root.close();
  }
});

test("R13 run while the plan sleeps cancels it; the run proceeds", async () => {
  const fake = fakeAgentSdk();

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const warm = talk.warm("a", plan());

    await advance(clock, 10 * minute);

    expect((await talk.run("a", { prompt: "hi", options }).result).status).toBe("done");

    expect(await warm.done).toEqual({ status: "cancelled", pings: 0 });

    await advance(clock, 200 * minute);

    expect(fake.calls.map((call) => call.prompt)).toEqual(["hi"]);
  } finally {
    await root.close();
  }
});

test("R13 run while a ping is in flight aborts it; the run's query starts after the ping's loop ended", async () => {
  const order: string[] = [];

  const pingScript: FakeScript = async function* (kit) {
    try {
      yield init(kit.session);
      await kit.hang();
    } finally {
      order.push("ping ended");
    }
  };

  const runScript: FakeScript = async function* (kit) {
    order.push("run started");
    yield init(kit.session);
    yield success(kit.session);
  };

  const fake = fakeAgentSdk(pingScript, runScript);

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    let pinged = 0;

    const warm = talk.warm("a", plan({ onPing: () => pinged++ }));

    await advance(clock, 50 * minute);

    expect(fake.calls).toHaveLength(1);

    const run = talk.run("a", { prompt: "hi", options });

    expect((await run.result).status).toBe("done");

    expect(order).toEqual(["ping ended", "run started"]);

    expect(await warm.done).toEqual({ status: "cancelled", pings: 0 });

    expect(pinged).toBe(0);

    expect(fake.calls[0]!.closed).toBe(1);
  } finally {
    await root.close();
  }
});

test("R13 run while a ping waits for a slot dequeues it with no query", async () => {
  const fake = fakeAgentSdk(hangs);

  const { clock, root } = warmScope(fake, 1);

  try {
    const talk = await root.resolve(agentTalk);

    const holder = talk.run("x", { prompt: "hold", options });

    const warm = talk.warm("a", plan());

    await advance(clock, 50 * minute);

    expect(fake.calls).toHaveLength(1);

    const run = talk.run("a", { prompt: "hi", options });

    expect(await warm.done).toEqual({ status: "cancelled", pings: 0 });

    talk.stop("x");

    expect((await holder.result).status).toBe("stopped");

    expect((await run.result).status).toBe("done");

    expect(fake.calls.map((call) => call.prompt)).toEqual(["hold", "hi"]);
  } finally {
    await root.close();
  }
});

test("R14 a second warm replaces the first; stop ends it stopped", async () => {
  const fake = fakeAgentSdk();

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const first = talk.warm("a", plan());

    await advance(clock, 10 * minute);

    const second = talk.warm("a", plan({ prompt: "ping two" }));

    expect(await first.done).toEqual({ status: "replaced", pings: 0 });

    await advance(clock, 50 * minute);

    expect(fake.calls.map((call) => call.prompt)).toEqual(["ping two"]);

    talk.stop("a");

    expect(await second.done).toEqual({ status: "stopped", pings: 1 });
  } finally {
    await root.close();
  }
});

test("I3 warm on one talk does not touch another", async () => {
  const fake = fakeAgentSdk();

  const { clock, root } = warmScope(fake);

  try {
    const talk = await root.resolve(agentTalk);

    const warmA = talk.warm("a", plan({ prompt: "ping a" }));

    const warmB = talk.warm("b", plan({ prompt: "ping b" }));

    expect((await talk.run("b", { prompt: "b turn", options }).result).status).toBe("done");

    expect(await warmB.done).toEqual({ status: "cancelled", pings: 0 });

    await advance(clock, 50 * minute);

    expect(fake.calls.map((call) => call.prompt)).toEqual(["b turn", "ping a"]);

    talk.stop("b");

    await advance(clock, 50 * minute);

    expect(fake.calls).toHaveLength(3);

    talk.stop("a");

    expect(await warmA.done).toEqual({ status: "stopped", pings: 2 });
  } finally {
    await root.close();
  }
});

for (const graceful of [true, false]) {
  test(`R14 I2 ${graceful ? "graceful" : "forced"} close ends warm plans closed and no timer fires after`, async () => {
    const fake = fakeAgentSdk(hangs);

    const { clock, root } = warmScope(fake);

    const talk = await root.resolve(agentTalk);

    const sleeping = talk.warm("a", plan());

    const pinging = talk.warm("b", plan({ everyMs: 10 * minute }));

    await advance(clock, 10 * minute);

    expect(fake.calls).toHaveLength(1);

    expect((await root.close({ graceful })).status).toBe("success");

    expect(fake.calls[0]!.ended).toBe(true);

    expect(await sleeping.done).toEqual({ status: "closed", pings: 0 });

    expect(await pinging.done).toEqual({ status: "closed", pings: 0 });

    await advance(clock, 300 * minute);

    expect(fake.calls).toHaveLength(1);

    expect(await talk.warm("c", plan()).done).toEqual({ status: "closed", pings: 0 });
  });
}
