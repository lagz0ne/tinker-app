import { drizzle } from "drizzle-orm/node-postgres";

/** The proof owns this client; the real session resource owns its BEGIN/COMMIT/ROLLBACK. */
export function writeDatabase(client, leaseFrom, logger) {
  const db = drizzle({ client, logger });
  return Object.assign(db, {
    checkout: async (guard) =>
      leaseFrom(
        async () =>
          new Proxy(client, {
            get(target, key) {
              if (key === "release") {
                return (broken) => {
                  if (broken) void target.end().catch(() => {});
                };
              }

              return Reflect.get(target, key, target);
            },
          }),
        drizzle,
        guard && { ...guard, logQuery: (...args) => logger?.logQuery(...args) },
      ),
  });
}

/** Native proof dispatch uses the same integration as server functions. */
export function writeDispatch() {
  return {
    async run(root, operation, call = {}) {
      const result = await this.settle(root, operation, call);
      if (result.status === "failed") throw result.error;
      if (result.status === "cancelled") throw result.reason;
      return result.value;
    },
    settle(root, operation, call = {}) {
      return root
        .controller(operation)
        .settle({ ...call, signal: call.signal ?? new AbortController().signal });
    },
  };
}
