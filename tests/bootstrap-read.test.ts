import { readFile } from "node:fs/promises";

import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import {
  authStartup,
  authSettings,
  user,
  session as authSession,
  liveAccount,
} from "~/components/auth/index.server";
import { database, databaseUrl, drizzleOrm, migrate } from "~/components/database/index.server";
import { startRequests, backendStop } from "~/components/requests";
import {
  stream,
  createAccountStream,
  bootstrapSlot,
  readAccountSlot,
} from "~/components/sync/index.server";

import { readAccount } from "@/demo/backend/auth.server";
import { bootstrap } from "@/demo/backend/sync.server";

import {
  proofDatabase,
  proofMail,
  handleAuth,
  requestHeaders,
  databaseQueries,
  transactionQueries,
} from "./presets";

for (const missing of [null, "private", "public"] as const) {
  test(`page bootstrap sends no stream INSERT or row lock; missing=${missing}`, async () => {
    const root = createScope({
      extensions: [startRequests, authStartup],
      presets: [proofDatabase, proofMail],
      tags: [
        backendStop(new AbortController().signal),
        bootstrapSlot(bootstrap),
        readAccountSlot(readAccount),
        databaseUrl(new URL("postgres://proof")),
        authSettings({
          origin: "http://localhost:4318",
          secret: "test-secret-with-at-least-thirty-two-letters",
        }),
      ],
    });

    await root.ready;
    try {
      await root.run(migrate);

      const response = await root.run(handleAuth, {
        input: new Request("http://localhost:4318/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:4318" },
          body: JSON.stringify({
            name: "page",
            email: "page@example.test",
            password: "safe-password-42",
          }),
        }),
        tags: requestHeaders(new Headers()),
      });

      expect(response.status).toBe(200);

      const headers = new Headers({
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      });

      const id = (await root.run(readAccount, { tags: requestHeaders(headers) }))!;

      const db = await root.resolve(database);

      const { eq } = await root.resolve(drizzleOrm);

      expect(await db.select().from(stream).where(eq(stream.id, id))).toEqual([
        { id, revision: 0 },
      ]);

      if (missing) {
        await db.delete(stream).where(eq(stream.id, missing === "private" ? id : "public"));
      }

      databaseQueries.length = 0;

      let snapshot;
      try {
        snapshot = await root.settle(bootstrap, { tags: requestHeaders(headers) });
      } finally {
        const queries = databaseQueries.filter((query) => query.includes('"sync_stream"'));

        expect(queries.length).toBeGreaterThan(0);

        expect(
          queries.some((query) => /\binsert\b/i.test(query)),
          "page bootstrap must not INSERT sync_stream",
        ).toBe(false);

        expect(
          queries.some((query) =>
            /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i.test(query),
          ),
          "page bootstrap must not row-lock sync_stream",
        ).toBe(false);
      }

      if (missing) {
        expect(snapshot).toMatchObject({ status: "failed", error: { kind: "StreamMissing" } });

        expect(
          await db
            .select()
            .from(stream)
            .where(eq(stream.id, missing === "private" ? id : "public")),
        ).toEqual([]);
      } else {
        expect(snapshot).toMatchObject({
          status: "success",
          value: { public: { revision: 0 }, private: { stream: id, revision: 0 } },
        });
      }
    } finally {
      await root.close({ graceful: true });
    }
  });
}

test("sign-up waits for stream initialization before returning", async () => {
  const entered = Promise.withResolvers<string>();

  const release = Promise.withResolvers<void>();

  const root = createScope({
    extensions: [startRequests, authStartup],
    presets: [
      proofDatabase,
      proofMail,
      preset(createAccountStream, async (_deps, ctx) => {
        entered.resolve(ctx.input.accountId);
        await release.promise;
        await createAccountStream.run({ database: await root.resolve(database) }, ctx);
      }),
    ],
    tags: [
      backendStop(new AbortController().signal),
      bootstrapSlot(bootstrap),
      readAccountSlot(readAccount),
      databaseUrl(new URL("postgres://proof")),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
      }),
    ],
  });

  await root.ready;
  try {
    await root.run(migrate);

    let returned = false;

    const pending = root
      .run(handleAuth, {
        input: new Request("http://localhost:4318/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:4318" },
          body: JSON.stringify({
            name: "held",
            email: "held@example.test",
            password: "safe-password-42",
          }),
        }),
        tags: requestHeaders(new Headers()),
      })
      .then((value) => {
        returned = true;

        return value;
      });

    const id = await entered.promise;

    expect(returned).toBe(false);

    release.resolve();

    expect((await pending).status).toBe(200);

    const db = await root.resolve(database);

    const { eq } = await root.resolve(drizzleOrm);

    await root.run(createAccountStream, { rawInput: { accountId: id } });

    expect(await db.select().from(stream).where(eq(stream.id, id))).toEqual([{ id, revision: 0 }]);
  } finally {
    release.resolve();

    await root.close({ graceful: true });
  }
});

test("migration backfills existing users idempotently without resetting revisions", async () => {
  const root = createScope({ presets: [proofDatabase] });

  await root.ready;
  try {
    await root.run(migrate);

    const db = await root.resolve(database);

    const { sql, eq } = await root.resolve(drizzleOrm);

    await db.insert(user).values({ id: "legacy", name: "Legacy", email: "legacy@example.test" });

    await db.update(stream).set({ revision: 7 }).where(eq(stream.id, "public"));

    const migration = await readFile(
      "drizzle/20261016143346_account_streams/migration.sql",
      "utf8",
    );

    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of migration.split("--> statement-breakpoint")) {
        await db.execute(sql.raw(statement));
      }
    }

    expect(await db.select().from(stream).orderBy(stream.id)).toEqual([
      { id: "legacy", revision: 0 },
      { id: "public", revision: 7 },
    ]);
  } finally {
    await root.close({ graceful: true });
  }
});

for (const failure of ["none", "user hook", "sign-in hook"] as const) {
  test(`sign-in repairs a missing stream and page loads; failure=${failure}`, async () => {
    let refuse = failure === "user hook";
    const root = createScope({
      extensions: [startRequests, authStartup],
      presets: [
        proofDatabase,
        proofMail,
        preset(createAccountStream, async (_deps, ctx) => {
          if (refuse) {
            refuse = false;
            throw new Error("stream insert refused once");
          }
          await createAccountStream.run({ database: await root.resolve(database) }, ctx);
        }),
      ],
      tags: [
        backendStop(new AbortController().signal),
        bootstrapSlot(bootstrap),
        readAccountSlot(readAccount),
        databaseUrl(new URL("postgres://proof")),
        authSettings({
          origin: "http://localhost:4318",
          secret: "test-secret-with-at-least-thirty-two-letters",
        }),
      ],
    });
    await root.ready;
    try {
      await root.run(migrate);
      const signup = await root.run(handleAuth, {
        input: new Request("http://localhost:4318/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:4318" },
          body: JSON.stringify({
            name: "Repair",
            email: "repair@example.test",
            password: "safe-password-42",
          }),
        }),
        tags: requestHeaders(new Headers()),
      });
      expect(signup.status, "user-hook failure must not fail committed sign-up").toBe(200);

      const db = await root.resolve(database);
      const { eq } = await root.resolve(drizzleOrm);
      const [account] = await db.select().from(user).where(eq(user.email, "repair@example.test"));
      await db.delete(stream).where(eq(stream.id, account.id));
      refuse = failure === "sign-in hook";

      let response;
      for (let attempt = 0; attempt < (failure === "sign-in hook" ? 2 : 1); attempt += 1) {
        response = await root.run(handleAuth, {
          input: new Request("http://localhost:4318/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://localhost:4318" },
            body: JSON.stringify({ email: "repair@example.test", password: "safe-password-42" }),
          }),
          tags: requestHeaders(new Headers()),
        });
        if (failure === "sign-in hook" && attempt === 0) {
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(await db.select().from(stream).where(eq(stream.id, account.id))).toEqual([]);
        }
      }

      expect(response!.status).toBe(200);
      expect(
        await db.select().from(stream).where(eq(stream.id, account.id)),
        "sign-in must repair the missing stream",
      ).toEqual([{ id: account.id, revision: 0 }]);
      const headers = new Headers({
        cookie: response!.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      });
      expect(await root.settle(bootstrap, { tags: requestHeaders(headers) })).toMatchObject({
        status: "success",
        value: { private: { stream: account.id } },
      });
    } finally {
      await root.close({ graceful: true });
    }
  });
}

test("direct auth hooks keep spans under scope resources and use the pool", async () => {
  const root = createScope({
    observe: { history: 200 },
    extensions: [startRequests, authStartup],
    presets: [proofDatabase, proofMail],
    tags: [
      backendStop(new AbortController().signal),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
      }),
    ],
  });
  await root.ready;
  try {
    await root.run(migrate);
    transactionQueries.length = 0;
    const signup = await root.settle(handleAuth, {
      input: new Request("http://localhost:4318/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4318" },
        body: JSON.stringify({
          name: "Trace",
          email: "trace@example.test",
          password: "safe-password-42",
        }),
      }),
      signal: new AbortController().signal,
    });
    expect(signup.status).toBe("success");
    if (signup.status !== "success") throw signup;
    expect(signup.value.status).toBe(200);

    const cookie = signup.value.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const signout = await root.settle(handleAuth, {
      input: new Request("http://localhost:4318/api/auth/sign-out", {
        method: "POST",
        headers: { cookie, origin: "http://localhost:4318", "content-type": "application/json" },
        body: "{}",
      }),
      signal: new AbortController().signal,
    });
    expect(signout.status).toBe("success");
    if (signout.status !== "success") throw signout;
    expect(signout.value.status).toBe(200);
    expect(transactionQueries, "auth hooks must not resolve the session transaction").toEqual([]);
  } finally {
    await root.close({ graceful: true });
  }

  const spans = root.spans();
  const owner = spans.find((span) => span.name === "auth")!;
  const created = spans.filter((span) => span.name === "sync.accountCreated");
  const deleted = spans.filter((span) => span.name === "sync.accountNotice");
  expect(created).toHaveLength(2);
  expect(deleted).toHaveLength(1);
  expect([...created, ...deleted].every((span) => span.parentId === owner.id)).toBe(true);

  const mailOwner = spans.find((span) => span.name === "mail.authWork")!;
  expect(spans.find((span) => span.name === "sendMail")!.parentId).toBe(mailOwner.id);
  console.log(
    "TRACE auth -> sync.accountCreated (user + session), sync.accountNotice; mail.authWork -> sendMail",
  );
});

for (const expired of [false, true]) {
  test(`page account, bootstrap and live reads write no tables; expired=${expired}`, async () => {
    const root = createScope({
      extensions: [startRequests, authStartup],
      presets: [proofDatabase, proofMail],
      tags: [
        backendStop(new AbortController().signal),
        bootstrapSlot(bootstrap),
        readAccountSlot(readAccount),
        authSettings({
          origin: "http://localhost:4318",
          secret: "test-secret-with-at-least-thirty-two-letters",
        }),
      ],
    });
    await root.ready;
    try {
      await root.run(migrate);
      const signup = await root.run(handleAuth, {
        input: new Request("http://localhost:4318/api/auth/sign-up/email", {
          method: "POST",
          headers: { origin: "http://localhost:4318", "content-type": "application/json" },
          body: JSON.stringify({
            name: "Old cookie",
            email: "old@example.test",
            password: "safe-password-42",
          }),
        }),
      });
      expect(signup.status).toBe(200);
      const headers = new Headers({
        cookie: signup.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      });
      const db = await root.resolve(database);
      const { eq } = await root.resolve(drizzleOrm);
      const [before] = await db.select().from(authSession);
      await db
        .update(authSession)
        .set({
          expiresAt: new Date(Date.now() + (expired ? -1000 : 3600000)),
          updatedAt: new Date(0),
        })
        .where(eq(authSession.id, before.id));

      databaseQueries.length = 0;
      expect(await root.run(readAccount, { tags: requestHeaders(headers) })).toBe(
        expired ? null : before.userId,
      );
      const snapshot = await root.run(bootstrap, { tags: requestHeaders(headers) });
      expect(snapshot.private?.stream ?? null).toBe(expired ? null : before.userId);
      expect(await root.run(liveAccount, { tags: requestHeaders(headers) })).toBe(
        expired ? null : before.userId,
      );
      expect(
        databaseQueries.filter((query) => /\b(insert|update|delete)\b/i.test(query)),
        "page reads must not write any table",
      ).toEqual([]);

      const action = await root.run(handleAuth, {
        input: new Request("http://localhost:4318/api/auth/get-session", {
          method: "POST",
          headers: { cookie: headers.get("cookie")!, origin: "http://localhost:4318" },
        }),
      });
      expect(action.status).toBe(200);
      const after = await db.select().from(authSession);
      if (expired) expect(after).toEqual([]);
      else expect(after[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 3600000);
    } finally {
      await root.close({ graceful: true });
    }
  });
}
