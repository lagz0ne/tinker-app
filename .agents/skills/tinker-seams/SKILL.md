---
name: tinker-seams
description: Keep wiring on the owner's public entries.
---

# Keep the seams

Read the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md) for the one-way imports,
required bindings, defineMain/exit, auth hooks, and copied-update policy.
Current Start commands are prepare, doctor, and serve. Add/update/check is
planned; it will stop on local edits and replace whole owned components.

Inspect the actual server, router, and start commands before changing wiring.
The command owns roots, config bindings, observers, and close order. Components
declare direct requires and use each other's public entries. A test may use
the private file it proves. Never forward a component through an app barrel
just to hide its owner.

Useful public entries:

- requests: startRequests, backendStop, requestStop; index.server has protocol state.
- database/index.server: database, transaction, databaseSetup, typed config, drizzleOrm.
- auth/index.server: auth settings, principal, liveAccount, and openSync.
- sync/index.server: eventHistory, account operations, notices, and server slots.
- sync: browser sync APIs, Register, reader slots, and recordsSlot.
- mail/index.server: mail, authMail, smtpUrl, mailFrom, and owned SMTP sockets.
- http/index.server: httpRequest; tests get httpBackend from http.

The stream implementation belongs to auth because it checks the live account.
Page bootstrap never creates stream rows. Signup/sign-in and the migration do.
Auth imports mandatory sync/mail work directly; there are no auth hook slots.

Follow src/routes/api.auth.$.ts and api.sync.ts for owned call dispatch. Bind
request values at that boundary. Host config and app/cross-root slots are
separate bindings. Follow the contract's checks after changing wiring.
