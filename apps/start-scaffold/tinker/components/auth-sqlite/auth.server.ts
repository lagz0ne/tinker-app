import { operation, resource } from "@tinker/core";
import type { DatabaseConnection, TransactionSettings } from "kysely";

import { database, transaction } from "~/components/database-sqlite/index.server";
import { requestHeaders } from "~/components/requests/index.server";
import { createAccountStream, publishAccountNotice } from "~/components/sync-sqlite/index.server";

import { betterAuthModule, betterAuthStart, kyselyModule, nodeSqliteDialect } from "./modules";
import { codeSignin, mcpProvider } from "./plugins.server";
import { authSettings } from "./settings.server";

/** The Postgres `session` trigger has no trigger here: each committed change says so itself. */
const publishSessionChange = operation({
  label: "auth.sessionChange",
  depends: { transaction },
  run: async ({ transaction }) => {
    await transaction.notify("start_sync", "session");
  },
});

/**
 * Better Auth's driver over the app's write connection, with its one checkout waiting for the
 * process's write turn. `node:sqlite` is synchronous and a session transaction stays open
 * across awaits, so a free-running writer would land inside another call's transaction.
 */
const authDriver = resource({
  label: "auth.driver",
  depends: { database, dialect: nodeSqliteDialect },
  factory: async ({ database, dialect }) => {
    const driver = new dialect.NodeSqliteDialect({ database: database.client }).createDriver();
    const turns = new Map<DatabaseConnection, () => void>();

    return {
      async init() {
        await driver.init();
      },
      async destroy() {
        // The database resource owns the connection and closes it with the scope.
      },
      async acquireConnection() {
        const release = await database.writeTurn();

        try {
          const connection = await driver.acquireConnection();

          turns.set(connection, release);

          return connection;
        } catch (error) {
          release();

          throw error;
        }
      },
      async releaseConnection(connection: DatabaseConnection) {
        try {
          await driver.releaseConnection(connection);
        } finally {
          turns.get(connection)?.();
          turns.delete(connection);
        }
      },
      async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
        await driver.beginTransaction(connection, settings);
      },
      async commitTransaction(connection: DatabaseConnection) {
        await driver.commitTransaction(connection);
      },
      async rollbackTransaction(connection: DatabaseConnection) {
        await driver.rollbackTransaction(connection);
      },
    };
  },
});

/**
 * A session delete sends the account notice after its commit: sign-out, a revoked or deleted
 * session, and a deleted user (its sessions go through the same delete) all end here.
 * The SQLite set has no mail component, so sign-in is the only email-password flow: no reset
 * mail and no verification mail. A code sign-in marks its session with the code, the browser,
 * and the OAuth client that approved it; the stock device routes are off, as the component
 * serves its own.
 */
export const auth = resource({
  label: "auth",
  depends: {
    database,
    settings: authSettings,
    writer: authDriver,
    dialect: nodeSqliteDialect,
    kysely: kyselyModule,
    created: createAccountStream,
    deleted: publishAccountNotice,
    changed: publishSessionChange,
    auth: betterAuthModule,
    start: betterAuthStart,
    codes: codeSignin,
    oauth: mcpProvider,
  },
  factory: async (
    {
      database,
      settings,
      writer,
      dialect,
      kysely,
      created,
      deleted,
      changed,
      auth,
      start,
      codes,
      oauth,
    },
    { closing, log },
  ) => {
    const { Kysely } = kysely;
    const base = new dialect.NodeSqliteDialect({ database: database.client });

    const db = new Kysely({
      dialect: {
        createDriver: () => writer,
        createAdapter: () => base.createAdapter(),
        createQueryCompiler: () => base.createQueryCompiler(),
        createIntrospector: (instance) => base.createIntrospector(instance),
      },
    });

    const { betterAuth } = auth;
    const { tanstackStartCookies } = start;

    const instance = betterAuth({
      baseURL: settings.origin,
      secret: settings.secret,
      database: { db, type: "sqlite" },
      session: {
        deferSessionRefresh: true,
        additionalFields: {
          signinCode: { type: "string", required: false, input: false },
          signinBrowser: { type: "string", required: false, input: false },
          signinApprovedBy: { type: "string", required: false, input: false },
        },
      },
      disabledPaths: [
        "/device/code",
        "/device/token",
        "/device",
        "/device/approve",
        "/device/deny",
      ],
      databaseHooks: {
        user: {
          create: {
            after: async ({ id }) => {
              try {
                await created.run({ input: { accountId: id }, signal: closing });
              } catch (error) {
                log.error("auth.accountStreamFailed", { accountId: id, error: String(error) });
              }
            },
          },
        },
        session: {
          create: {
            after: async ({ userId }) => {
              await created.run({ input: { accountId: userId }, signal: closing });
              await changed.run({ signal: closing });
            },
          },
          update: {
            after: () => changed.run({ signal: closing }),
          },
          delete: {
            after: async ({ userId }) => {
              // The Postgres trigger spoke before the account notice; keep that order.
              await changed.run({ signal: closing });
              await deleted.run({ rawInput: { accountId: userId }, signal: closing });
            },
          },
        },
      },
      emailAndPassword: {
        enabled: true,
      },
      hooks: { before: oauth.clientCheck },
      plugins: [...oauth.plugins, ...codes, tanstackStartCookies()],
    });

    // Plugin start-up writes (the OAuth provider seeds its MCP resource row) end before the
    // resource is ready, so a scope that closes early never closes the database under them.
    await instance.$context;

    return instance;
  },
});

export const principal = resource({
  label: "request.principal",
  target: "session",
  depends: { auth, headers: requestHeaders },
  factory: async ({ auth, headers }) =>
    (
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
    )?.user ?? null,
});

/** A long stream rechecks the live cookie without using caches or refreshing the session. */
export const liveAccount = operation({
  label: "sync.liveAccount",
  depends: { auth, headers: requestHeaders },
  run: async ({ auth, headers }) =>
    (
      await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
    )?.user.id ?? null,
});
