# Task, step 10: a welcome mail

You built the issue board in steps 1 to 9. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck9.md` are the tasks before this one. They
still hold.

You work in this folder only. Do not read files outside it.

## What is new

These given files are new or changed. Do not
change them:

- `src/issues/mail.ts` (new): the tag `mailer`.
  Its value has `send(to, subject, body)`. It
  answers when the mail has left. It can throw
  (mail is down). It can also never answer (mail
  hangs).
- `cmds/server.ts`: it binds a stand-in mailer
  (it writes each mail to stdout). Each second it
  runs `drainMail` from
  `src/issues/outbox.server.ts`.
- `tinker.json`: one exception, for that
  stand-in mailer. You may still add
  `graph.rules`.

The other given files stay given:
`src/issues/contract.ts`, `src/issues/sign-in.ts`,
`src/issues/index.ts`, `src/routes.tsx`.

Write `src/issues/outbox.server.ts`. It exports
`drainMail`: an operation with no input. Change
your own files: the ops, the pages, your tests.

A test binds a fake mailer on the server scope:

```ts
createScope({ clock, tags: [mailer(fake)], capsules: [...] });
```

## Server journeys

S17. A person added to a team gets one welcome
mail.

- `team.add` of a person who is not in the team
  yet: one mail, to their `userId`, subject
  `Welcome to <teamId>` (`Welcome to ENG`). The
  body is yours.
- A role change of a person in the team sends no
  mail. Nor does a `team.add` that answers
  `gone`, `forbidden` or `archived`.
- The call answers at once, also when mail is down
  or hangs. It never waits for the mail.
- `drainMail` sends the mail that waits. A mail
  waits until a send of it answers.
- A send that throws: the mail waits for the next
  `drainMail`.
- A send that does not answer in 5 s on the scope
  clock: that `drainMail` gives up on it. The
  mail waits for the next `drainMail`.
- In the end each add gives exactly one mail. Two
  `drainMail` runs at the same time never send one
  mail twice. A mail that a `drainMail` is still
  sending is not sent again by another one.

Use time only from the operation's `clock`.

## Rules your server keeps

R1 to R8 hold, as in step 9. These change:

- R4. An answer that is not a success writes
  nothing: no issue, no label, no event, no mail.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 10 that still hold.
