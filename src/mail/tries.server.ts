import { capsule, data, operation } from "@tinkered/core";
import { z } from "zod";

import { letter, type Letter } from "./letter";
import { mailProvider } from "./provider";

// A backend that tries again. `deliver` puts the letter in a line and answers. A pump, started by
// the capsule's start hook, tries each letter that is due through `mailProvider.send`. A failed try
// waits 1 s, then 2 s, then 4 s; after `most` failed tries the letter is given up and kept.
// Built on the queue (dead letter) and retry (backoff) patterns of the messaging and resilience
// skills. The pump runs with no signal, so its writes land at the root. Its own signal does not
// abort when the scope closes by the cmd's signal (0.34.19), so the hook hands it `closing` too.

/** One letter that waits: how many tries failed, and when it may be tried (scope clock). */
const item = z.object({ id: z.string(), letter, failed: z.number(), next: z.number() });

/** The letters that wait. Written at the root (`atScope`): a call's write outlives the call. */
const line = data({
  label: "mail.tries.line",
  mode: "keyed",
  parse: item,
  key: (i) => ({ id: i.id }),
});

/** The letters given up, oldest first. */
const givenUp = data<Letter[]>({ label: "mail.tries.givenUp", initial: [] });

/** The most tries of one letter. */
const most = 4;

/** The wait after the first failed try; each next wait is twice the one before. */
const firstWait = 1_000;

/** How long one try may take, on the scope clock. Then it has failed. */
const patience = 10_000;

/** How often the pump looks at the line. */
const tick = 1_000;

/** Put one letter in the line. It sends nothing itself. */
const deliver = operation({
  label: "mail.tries.deliver",
  input: letter,
  depends: { line: line.atScope.controller },
  run: ({ line }, { input, random, clock }) => {
    line.set({ id: random.uuid(), letter: input, failed: 0, next: clock.currentTimeMillis() });
  },
});

/** Try one letter once. A try that throws, or that has not answered in `patience`, has failed:
 * the letter waits, or is given up after `most` tries. */
const tryOne = operation({
  label: "mail.tries.tryOne",
  input: item,
  depends: {
    provider: mailProvider.send,
    line: line.atScope.controller,
    givenUp: givenUp.atScope.controller,
  },
  run: async ({ provider, line, givenUp }, { input, clock, signal }) => {
    const stop = new AbortController();
    const late = clock.sleep(patience, AbortSignal.any([signal, stop.signal])).then(
      () => false,
      () => false,
    );
    const done = provider.settle({ input: input.letter }).then((r) => r.status === "success");
    const ok = await Promise.race([done, late]);
    stop.abort();
    if (ok) {
      line.delete({ id: input.id });
      return { kind: "sent" as const };
    }

    const failed = input.failed + 1;
    if (failed < most) {
      const next = clock.currentTimeMillis() + firstWait * 2 ** (failed - 1);
      line.set({ ...input, failed, next });
      return { kind: "waits" as const };
    }
    line.delete({ id: input.id });
    givenUp.update((list) => [...list, input.letter]);
    return { kind: "givenUp" as const };
  },
});

/** Each `tick`, start a try of each letter that is due, and hold it while it runs. A try that
 * hangs holds only its own letter. Ends when the scope closes: its input is the hook's `closing`. */
const pump = operation({
  label: "mail.tries.pump",
  input: z.instanceof(AbortSignal),
  depends: { line: line.atScope.controller, one: tryOne },
  run: async ({ line, one }, { input: closing, clock, signal }) => {
    const end = AbortSignal.any([signal, closing]);
    for (;;) {
      const now = clock.currentTimeMillis();
      for (const due of line.get().filter((i) => i.next <= now)) {
        line.set({ ...due, next: now + 2 * patience });
        void one.settle({ input: due });
      }
      const slept = await clock.sleep(tick, end).then(
        () => true,
        () => false,
      );
      if (!slept) return;
    }
  },
});

export const triedMail = capsule({
  label: "mail.tries",
  exports: { deliver, givenUp },
  hooks: {
    async start({ next, run, closing }) {
      await next();
      void run(
        pump,
        { input: closing },
        { role: "handler", explain: "Tries each due letter each second" },
      );
    },
  },
});
