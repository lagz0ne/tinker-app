---
name: tinker-testing
description: Prove app promises through small scopes.
---

# Test through a scope

Use this when adding or fixing app behavior.
Read `tests/todos.test.ts` for a full example.
Import exported operations from the app's package seams.
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
One test names one public cause and decisive outcome.
A bug test must fail without the fix.
Count calls or spans to prove less work; never time them.
Run `npm run build` before types and tests.
