---
name: tinker-testing
description: Prove app promises through small scopes.
---

# Test through a scope

Use this when adding or fixing app behavior.
Read `tests/todos.test.ts` for a full example.
Import exported operations from the app's package seams.
Bind raw request headers only through the testing entry:

```ts
import { requestHeaders } from "@tinker/start/testing";
```

App code uses principal or currentUser.
Do not import private source files.
Do not boot Start to test an operation.

`tests/presets.ts` replaces database and mail resources.
The database runs real queries with PGlite.
`proofMail` only records sends; it does not deliver mail.
Held and refused mail use inline `preset(mail, ...)` fixtures.
See `tests/sync.test.ts` for both.
Use `preset` from `@tinker/core/testing` only in tests.
Never import that entry from app source.
Do not use mocks, spies, global patches, or sleep waits.

```ts
const stop = new AbortController();
const app = createScope({
  signal: stop.signal,
  tags: settings,
  presets: [proofDatabase, proofMail],
});
await app.ready;
try {
  await app.run(migrate);
  expect(
    await app.run(readProfile, {
      tags: requestHeaders(new Headers()),
    }),
  ).toBeNull();
} finally {
  stop.abort();
  expect((await app.closed).status).toBe("success");
}
```

Give `settings` the database, auth, and mail tags.
The worked tests show their filled values.
For outgoing HTTP, bind httpBackend through the base testing entry:

```ts
const stop = new AbortController();
const app = createScope({
  signal: stop.signal,
  tags: [httpBackend(async () => new Response("saved", { status: 201 }))],
});
await app.ready;
try {
  expect(
    await app.run(httpRequest, {
      rawInput: {
        url: "https://no-network.invalid/notices",
        method: "POST",
        body: "The order is ready.",
      },
    }),
  ).toEqual({
    status: 201,
    headers: {
      "content-type": ["text/plain;charset=UTF-8"],
    },
    body: "saved",
  });
} finally {
  stop.abort();
  await app.closed;
}
```

Import httpBackend from `@tinker/start/testing`.
Import httpRequest from `@tinker/start/server`.
Bind the fake in the test's scope; never replace global fetch.

One test names one public cause and decisive outcome.
A bug test must fail without the fix.
Count calls or spans to prove less work; never time them.
Run `npm run build` before types and tests.
