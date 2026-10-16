import { readFile } from "node:fs/promises";

import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { authStartup, authSettings, user, userCreated } from "~/components/auth/index.server";
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
  authBindings,
  proofDatabase,
  proofMail,
  handleAuth,
  requestHeaders,
  databaseQueries,
} from "./presets";

for (const missing of [null, "private", "public"] as const) {
  test(`page bootstrap sends no stream INSERT or row lock; missing=${missing}`, async () => {
    const root = createScope({
      extensions: [startRequests, authStartup],
      presets: [proofDatabase, proofMail],
      tags: [
        authBindings,
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
    presets: [proofDatabase, proofMail],
    tags: [
      authBindings,
      backendStop(new AbortController().signal),
      bootstrapSlot(bootstrap),
      readAccountSlot(readAccount),
      databaseUrl(new URL("postgres://proof")),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
      }),
      userCreated(async (accountId, ctx) => {
        entered.resolve(accountId);

        await release.promise;

        await ctx.run(createAccountStream, { rawInput: { accountId } });
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
      presets: [proofDatabase, proofMail],
      tags: [
        authBindings,
        backendStop(new AbortController().signal),
        bootstrapSlot(bootstrap),
        readAccountSlot(readAccount),
        databaseUrl(new URL("postgres://proof")),
        authSettings({
          origin: "http://localhost:4318",
          secret: "test-secret-with-at-least-thirty-two-letters",
        }),
        userCreated(async (accountId, ctx) => {
          if (refuse) {
            refuse = false;
            throw new Error("stream insert refused once");
          }
          await ctx.run(createAccountStream, { rawInput: { accountId } });
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
