# Task, step 12: a mail is tried a few times

You built the issue board in steps 1 to 11. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck11.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

`@tinkered/*` is at 0.34.19 now. Its skills ship
with it.

The mail parts are given (new). Do not change
them:

- `src/mail/letter.ts`: `letter`, one mail (`to`,
  `subject`, `body`).
- `src/mail/index.ts`: the capsule `mail`. Your
  board sends a mail with `mail.send`. Its config
  `backend` holds the operation that takes the
  letter.
- `src/mail/provider.ts`: the capsule
  `mailProvider`. `mailProvider.send` hands one
  letter to the mail server. Its config `provider`
  holds the operation that does it. That operation
  can throw: mail is down. It can also never
  answer: mail hangs.
- `src/mail/memory.server.ts`: `memoryMail`, a
  backend that keeps each letter in a cell. Use it
  in your own tests if you like.

`src/issues/mail.ts` and its tag `mailer` are gone.
Delete the file.

The tests install a fake mail server in
`mailProvider`, and then your `serverParts`:

```ts
createScope({
  clock,
  capsules: [
    exits({ file: process.env.TINKER_EXITS }),
    fake(),
    mailProvider({ provider: fake.send }),
    ...serverParts,
    issues.board({ ... }),
    issues.api({ ... }),
  ],
});
```

The tests do not install `mail`. Your
`serverParts` installs it, with a backend of
yours.

`src/issues/ops.server.ts` also exports `givenUp`:
a cell (`data<Letter[]>`) that holds each mail
given up. The tests read it:
`server.resolve(givenUp).get()`.

`cmds/server.ts` stays yours. In `tinker.json` you
may add `graph.rules`, and add or take away a
`plain` entry for a file of yours, with its reason.
Do not change its other keys.

## Server journeys

S17 changes. The rest of S17 holds.

- A mail is tried at most 4 times.
- A try has failed when it throws, or when it has
  not answered in 10 s. Before the 10 s, the mail
  is not tried again.
- After a failed try, the mail waits: 1 s after
  the first, 2 s after the second, 4 s after the
  third. It is tried again within 1 s after its
  wait.
- After its 4th failed try, the mail is given up.
  It is never tried again. `givenUp` keeps it
  once, in the order the mails were given up.
- A try that never answers, and a mail that waits,
  hold no other mail: with mail up, another mail
  arrives within 2 s.
- A mail that arrives is not tried again, and is
  not given up.
- The server can stop while a try hangs and a mail
  waits. Its close then ends at once.
- The server cmd (`bun cmds/host.ts`) still has no
  mail server. It writes each mail to its stdout,
  as one line: `mail to bo: Welcome to ENG`.

Time is the server scope's clock only.

## Rules your server keeps

R1 to R8 hold, as in step 11.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 12 that still hold.
