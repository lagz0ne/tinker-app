# Task, step 10: a welcome mail

You built the issue board in steps 1 to 9. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck9.md` are the tasks before this one. They
still hold.

You work in this folder only. Do not read files outside it.

## What is new

`src/issues/mail.ts` is given (new). Do not change
it. It holds the tag `mailer`. Its value has
`send(to, subject, body)`. It answers when the mail
has left. It can throw: mail is down. It can also
never answer: mail hangs.

These stay given: `src/issues/contract.ts`,
`src/issues/sign-in.ts`, `src/issues/index.ts`,
`src/routes.tsx`, and `cmds/**` except
`cmds/server.ts`.

`cmds/server.ts` is yours now. You may change it.
In `tinker.json` you may add `graph.rules`, and a
`plain` entry for a file of yours, with its reason.
Do not change its other keys.

`src/issues/ops.server.ts` also exports
`serverParts`: a list of the capsules your board
needs on the server, besides `issues.board` and
`issues.api`. It may be empty. The server cmd
installs them, and so do the tests.

## Server journeys

S17. A person added to a team gets one welcome
mail.

- `team.add` of a person who is not in the team
  yet: one mail, to their `userId`, subject
  `Welcome to <teamId>` (`Welcome to ENG`). The
  body is yours.
- A role change sends no mail. Nor does a
  `team.add` that answers `gone`, `forbidden` or
  `archived`.
- `team.add` answers at once, also when mail is
  down or never answers.
- With mail up, the mail arrives within 2 s.
- A send that throws, or that has not answered in
  10 s, has failed. The mail is tried again.
  Before the 10 s, it is not sent again.
- Once mail is back, the mail arrives within 1
  minute.
- In the end each add gives exactly one mail that
  arrived, also after failures, and also when
  sends are slow.
- The server cmd (`bun cmds/host.ts`) has no mail
  server. Its mailer writes each mail to its
  stdout, as one line, for example:
  `mail to bo: Welcome to ENG`

Tests bind a fake mailer and a test clock on the
server scope:

```ts
createScope({ clock, tags: [mailer(fake)], capsules: [...] });
```

Time is the scope's clock only.

## Rules your server keeps

R1 to R8 hold, as in step 9. These change:

- R4. An answer that is not a success writes
  nothing: no issue, no label, no event, no mail.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 10 that still hold.
