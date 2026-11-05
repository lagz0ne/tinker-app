import { data, operation, resource } from "@tinker/core";
import { z } from "zod";

/**
 * One reader's two numbers: how many reads it has started, and how many answers it has applied.
 * A reader is one screen's load, named by its own key, so one screen's answer never drops
 * another's.
 */
export const liveReads = data<Readonly<Record<string, { asked: number; applied: number }>>>({
  label: "live.reads",
  initial: {},
});

/** Moves once per change notice: a reader watches it to know the store changed. */
export const liveRevision = data({ label: "live.revision", initial: 0 });

/**
 * The re-read generation: it moves once per burst of change notices, 120 ms after the last one, so
 * every reader that watches it reads again together, on one timer.
 */
export const liveGeneration = data({ label: "live.generation", initial: 0 });

/** How long a burst waits before the re-read, so a run of notices makes one read. */
const SOON_MS = 120;

/**
 * The number of the read starting now, for the reader named by `key`. A read takes its number
 * before it asks, and hands it to `live.answer` with the answer.
 */
export const liveRead = operation({
  label: "live.read",
  input: z.object({ key: z.string().min(1) }),
  depends: { reads: liveReads.controller },
  run: ({ reads }, { input }): number => {
    const held = reads.get();
    const mine = held[input.key] ?? { asked: 0, applied: 0 };
    const ticket = mine.asked + 1;

    reads.set({ ...held, [input.key]: { ...mine, asked: ticket } });

    return ticket;
  },
});

/**
 * Whether this answer is the one the reader keeps: false when a newer answer has already been
 * applied for the key (an older list would put stale data back), true otherwise. A kept answer
 * becomes the reader's last applied.
 */
export const liveAnswer = operation({
  label: "live.answer",
  input: z.object({ key: z.string().min(1), ticket: z.number().int().min(1) }),
  depends: { reads: liveReads.controller },
  run: ({ reads }, { input }): boolean => {
    const held = reads.get();
    const mine = held[input.key];

    if (mine === undefined || mine.applied >= input.ticket) return false;

    reads.set({ ...held, [input.key]: { ...mine, applied: input.ticket } });

    return true;
  },
});

/** One change notice: the revision moves, and the coalesced re-read below waits for the burst. */
export const liveNotice = operation({
  label: "live.notice",
  depends: { revision: liveRevision.controller },
  run: ({ revision }): void => {
    revision.set(revision.get() + 1);
  },
});

/**
 * The one re-read timer: a burst of change notices starts a wait of 120 ms, and only the last
 * wait of the burst moves `liveGeneration`; an earlier notice's wait finds a newer one and does
 * nothing. The waits carry the scope clock (`ctx.clock`), so a test moves time by hand.
 */
export const liveSoon = resource({
  label: "live.soon",
  depends: { revision: liveRevision.controller, generation: liveGeneration.controller },
  factory: ({ revision: revisionCell, generation }, { defer, clock, signal }) => {
    let last = 0;

    defer(
      revisionCell.watch(() => {
        const mine = ++last;

        void clock.sleep(SOON_MS, signal).then(
          () => {
            if (mine === last) generation.set(generation.get() + 1);
          },
          () => undefined,
        );
      }),
    );
  },
});
