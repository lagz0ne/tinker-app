import { operation, resource, tag } from "@tinker/core";
import type { Many, Scope } from "@tinker/core";
import type { PGliteInterface } from "@electric-sql/pglite";
import { afterAll, beforeAll } from "vite-plus/test";
import type { Database } from "../../src/parts/sync/database";

/**
 * A stand-in server seam for the base's own tests and type check, as `#tinker/app.server`:
 * the names the auth and sync parts read. Its auth library echoes each request it is handed,
 * and signs a request in by its `x-account` header, while that account is in `signedIn`.
 */
export const extensions: Many<Scope.Extension<unknown>> = [];
export const signedIn = tag<ReadonlySet<string>>({ label: "test.signedIn", default: new Set() });
export const auth = resource({
  label: "test.auth",
  depends: { accounts: signedIn },
  factory: ({ accounts }) => ({
    handler: async (request: Request) =>
      Response.json({ method: request.method, path: new URL(request.url).pathname }),
    api: {
      getSession: async ({ headers }: { headers: Headers; query?: object }) => {
        const id = headers.get("x-account");
        return id !== null && accounts.has(id) ? { user: { id } } : null;
      },
    },
  }),
});
export const readAccount = operation({ label: "test.readAccount", run: () => null });
/** The app's snapshot for a request: no account, at the start of the public stream. */
export const bootstrap = operation({
  label: "test.bootstrap",
  run: () => ({ public: { stream: "public" as const, revision: 0 }, private: null }),
});

/** The sync part's tables and wake trigger, as an app's migrations create them. */
export const syncTables = `
CREATE TABLE sync_stream (id text PRIMARY KEY, revision integer DEFAULT 0 NOT NULL);
CREATE TABLE sync_execution (id text PRIMARY KEY, stream text NOT NULL, notification jsonb, result jsonb);
CREATE TABLE sync_event (stream text, revision integer, "executionId" text NOT NULL,
  payload jsonb NOT NULL, PRIMARY KEY (stream, revision));
CREATE FUNCTION start_sync_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_notify('start_sync', TG_TABLE_NAME); RETURN NULL; END; $$;
CREATE TRIGGER sync_event_committed AFTER INSERT ON sync_event
FOR EACH STATEMENT EXECUTE FUNCTION start_sync_wake();
`;

/** Each scope owns a copy; the file owns the empty template and closes it after its tests. */
export let syncTemplate: PGliteInterface;
beforeAll(async () => {
  const [{ PGlite }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm"),
    import("drizzle-orm/pglite"),
    import("../../src/parts/sync/schema"),
  ]);
  syncTemplate = await PGlite.create();
  await syncTemplate.exec(syncTables);
}, 60_000);
afterAll(() => syncTemplate.close());

/** An in-memory Postgres (PGlite, no server) with the sync tables, as the app's database. */
export const database = resource({
  label: "test.database",
  factory: async (_deps, { defer }): Promise<Database.Handle> => {
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = await syncTemplate.clone();
    defer(() => client.close());
    return Object.assign(drizzle({ client }), {
      listen: async (wake: () => void) => client.listen("start_sync", wake),
    });
  },
});
