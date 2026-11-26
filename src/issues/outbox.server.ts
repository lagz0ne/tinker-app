import { data, operation } from "@tinkered/core";
import { z } from "zod";

import { mailer } from "./mail";

// The outbox: a call puts its mail here and answers. A drain sends it later: the server's cmd runs
// `drainMail` each second, at the root. Built from Core parts: a keyed cell, the scope clock, and
// one drain op. A mail leaves the outbox only when its send answered, so mail that is down or slow
// loses nothing. A call never runs the drain: Core ends a call only when the runs it started end.

/** One mail to send. `until`: a drain that took the mail holds it until then (0: nobody holds it). */
const letter = z.object({
  id: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  until: z.number(),
});

/** The mail that waits. Written at the root (`atScope`): a call's write outlives the call. */
const outbox = data({
  label: "issues.outbox",
  mode: "keyed",
  parse: letter,
  key: (l) => ({ id: l.id }),
});

/** How long a drain waits for one send, on the scope clock. Then the mail waits for a later drain. */
const patience = 5_000;

/** Put one mail in the outbox. It sends nothing itself. */
export const post = operation({
  label: "issues.post",
  input: letter.pick({ to: true, subject: true, body: true }),
  depends: { box: outbox.atScope.controller },
  run: ({ box }, { input, random }) => box.set({ ...input, id: random.uuid(), until: 0 }),
});

/** Send each mail in the outbox that no drain holds. A drain first holds each mail it takes, so
 * a second drain at the same time skips it: no mail goes twice. A send that throws, or that does
 * not answer within `patience`, puts the mail back for the next drain. A drain changes a mail only
 * while it still holds it. */
export const drainMail = operation({
  label: "issues.drainMail",
  depends: { box: outbox.atScope.controller, mail: mailer.required },
  run: async ({ box, mail }, { clock, signal }) => {
    const now = clock.currentTimeMillis();
    const hold = now + 2 * patience;
    const free = box.get().filter((l) => l.until <= now);
    for (const l of free) box.set({ ...l, until: hold });

    let sent = 0;
    for (const l of free) {
      const stop = new AbortController();

      const late = clock.sleep(patience, AbortSignal.any([signal, stop.signal])).then(
        () => false,
        () => false,
      );
      const done = mail.send(l.to, l.subject, l.body).then(
        () => true,
        () => false,
      );
      const ok = await Promise.race([done, late]);
      stop.abort();

      const held = box.of({ id: l.id }).get();
      if (held?.until !== hold) continue;

      if (ok) {
        box.delete({ id: l.id });
        sent += 1;
      } else box.set({ ...held, until: 0 });
    }
    return { sent, waiting: box.get().length };
  },
});
