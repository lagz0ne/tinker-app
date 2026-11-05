import { expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { z } from "zod";

import { liveAnswer, liveGeneration, liveNotice, liveRead, liveSoon } from "~/components/live-read";

/** What a reader puts on screen: a kept answer writes it, a dropped answer leaves it alone. */
const shown = data({ label: "live-read.test.shown", initial: [] as string[] });

/** Flushes the microtasks a settled clock sleep and a run leave behind. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("two reads in flight: the newer answer lands first, the older last, and the newer list stays", async () => {
  const gates: Array<(list: string[]) => void> = [];
  const load = operation({
    label: "live-read.test.load",
    input: z.object({ key: z.string() }),
    depends: { ask: liveRead.controller, kept: liveAnswer.controller, shown: shown.controller },
    run: async ({ ask, kept, shown: shownCell }, { input }) => {
      const ticket = ask.run({ input: { key: input.key } });
      const list = await new Promise<string[]>((resolve) => void gates.push(resolve));

      if (kept.run({ input: { key: input.key, ticket } })) shownCell.set(list);
    },
  });
  const scope = createScope({ capsules: [] });
  await scope.ready;

  const first = scope.run(load, { input: { key: "screen" } });
  const second = scope.run(load, { input: { key: "screen" } });
  await tick();
  expect(gates).toHaveLength(2);

  // The newer read answers first: its list is the one applied.
  gates[1]!(["one", "two"]);
  await second;
  expect(scope.controller(shown).get()).toEqual(["one", "two"]);

  // The older read answers last: its list is dropped, so the newer one stays.
  gates[0]!(["one"]);
  await first;
  expect(scope.controller(shown).get()).toEqual(["one", "two"]);

  await scope.close();
});

test("three change notices in a row make one re-read, 120 ms after the last", async () => {
  const clock = makeTestClock();
  const scope = createScope({ clock });
  await scope.ready;
  scope.resolve(liveSoon);

  const generation = scope.controller(liveGeneration);
  scope.run(liveNotice);
  scope.run(liveNotice);
  scope.run(liveNotice);
  await tick();

  clock.advance(119);
  await tick();
  expect(generation.get()).toBe(0);

  clock.advance(1);
  await tick();
  expect(generation.get()).toBe(1);

  // The timer is armed again for the next burst.
  scope.run(liveNotice);
  await tick();
  clock.advance(119);
  await tick();
  expect(generation.get()).toBe(1);

  clock.advance(1);
  await tick();
  expect(generation.get()).toBe(2);

  await scope.close();
});

test("each reader keeps its own numbers, so one reader's answer never drops another's", async () => {
  const scope = createScope({ capsules: [] });
  await scope.ready;

  const left = scope.run(liveRead, { input: { key: "left" } });
  const right = scope.run(liveRead, { input: { key: "right" } });
  expect(left).toBe(1);
  expect(right).toBe(1);

  expect(scope.run(liveAnswer, { input: { key: "right", ticket: right } })).toBe(true);
  expect(scope.run(liveAnswer, { input: { key: "left", ticket: left } })).toBe(true);

  await scope.close();
});
