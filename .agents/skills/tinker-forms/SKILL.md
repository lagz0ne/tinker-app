---
name: tinker-forms
description: Choose the owner of new app code.
---

# Choose a form

Read the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/main/docs/decisions/start-decompose.md) first. It owns the rules for
forms, native boundaries, imports, settings, pure helpers, and the cap of 17.
Do not copy a second version of those rules into feature code.

Choose a tag for an injected value, data for visible state, a resource for an
owned client/private work state, or an operation for an action. The examples
are databaseUrl, profile/nameDraft, database/auth, and changeTodo. Counter and todo writes now use the session transaction; profile mail is the
remaining coupled migration.

For a new write, read database.transaction and the board's issues.change steps.
Resolve transaction only in write steps; reads keep database. A native call
owns the child session and joins its end before returning a reply.

Keep lazy outside-library resources in the owner's modules.ts. Use drizzleOrm
from the database public entry. Schemas and tables are declarations, not live
clients. A schema used once stays a schema. Validate raw input at the operation
boundary; use its result rather than a type cast.

Feature outgoing HTTP uses httpRequest.controller. Pass raw plain request
values; map status/body to a feature value or typed error. Tests replace
httpBackend through the HTTP public entry. Native Request/Response values
belong to routes, server functions, and the named auth mount.

Review `PLAIN.md` when keeping a pure helper. Run both plain checks after
changing its rules. The script is the full checked declaration/callback list.
