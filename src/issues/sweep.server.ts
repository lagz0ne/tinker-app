import { capsule, data, operation } from "@tinkered/core";
import { z } from "zod";

import { archived, events, issues, labels } from "./contract";

// A deleted team's parts go later: the delete call takes its members (so the team is hidden at
// once) and marks the key. The sweeper, a root worker, takes the other parts, at most `batch` a
// tick, and then frees the key. Built from Core parts: a keyed cell, the scope clock, one sweep
// op, and a capsule start hook.

/** The keys whose old parts are still going. Written at the root (`atScope`): a call's write
 * outlives the call. A marked key cannot be made again. */
export const deleting = data({
  label: "issues.deleting",
  mode: "keyed",
  parse: z.object({ teamId: z.string() }),
  key: (d) => ({ teamId: d.teamId }),
});

/** The most parts one tick takes, over every marked key. */
const batch = 100;

/** How often the sweeper looks, on the scope clock. */
const tick = 1_000;

/** Take up to `room` parts of one key: its labels, events, issues, then its archive mark. It
 * answers the room left; `done` when every part fit, so the key has none left. */
const sweepTeam = operation({
  label: "issues.sweepTeam",
  input: z.object({ teamId: z.string(), room: z.number() }),
  depends: {
    list: issues.controller,
    shut: archived.controller,
    tags: labels.controller,
    log: events.controller,
  },
  run: ({ list, shut, tags, log }, { input }) => {
    const part = { teamId: input.teamId };
    const named = tags.where(part).get().slice(0, input.room);
    for (const { id, name } of named) tags.delete({ ...part, id, name });
    let room = input.room - named.length;

    const old = log.where(part).get().slice(0, room);
    for (const { id, version } of old) log.delete({ ...part, id, version });
    room -= old.length;

    const gone = list.where(part).get().slice(0, room);
    for (const { id } of gone) list.delete({ ...part, id });
    room -= gone.length;

    const marked = room > 0 && shut.of(part).get() !== undefined;
    if (marked) shut.delete(part);

    room -= marked ? 1 : 0;
    return { room, done: room > 0 };
  },
});

/** Take up to `batch` parts over the marked keys, and free each key that has none left. Run
 * twice, it takes nothing twice: each part goes once. */
const sweep = operation({
  label: "issues.sweep",
  depends: { marks: deleting.atScope.controller, one: sweepTeam },
  run: ({ marks, one }) => {
    let room = batch;
    for (const { teamId } of marks.get()) {
      if (room <= 0) break;

      const now = one.run({ input: { teamId, room } });
      room = now.room;
      if (now.done) marks.delete({ teamId });
    }
    return { room };
  },
});

/** Sweep each `tick` until the server closes. Its signal is the root's closing signal, so a
 * graceful close ends it too. */
const sweeper = operation({
  label: "issues.sweeper",
  depends: { step: sweep },
  run: async ({ step }, { clock, signal }) => {
    while (!signal.aborted) {
      step.run();
      await clock.sleep(tick, signal).catch(() => undefined);
    }
  },
});

/** The server part that takes a deleted team's parts: its start runs the sweeper as a root
 * worker and returns. */
export const teamSweeper = capsule({
  label: "issues.teamSweeper",
  hooks: {
    start: ({ settle, closing }) => {
      const meta = {
        role: "worker" as const,
        explain: "Takes a deleted team's parts, a batch a second",
      };
      void settle(sweeper, { signal: closing }, meta);
    },
  },
});
