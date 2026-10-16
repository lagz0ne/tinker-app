import { drizzle } from "drizzle-orm/node-postgres";

/** The proof owns this client; the real session resource owns its BEGIN/COMMIT/ROLLBACK. */
export function writeDatabase(client, logger) {
  const db = drizzle({ client, logger });
  return Object.assign(db, {
    checkout: async (guard) => ({
      db: drizzle({
        client: new Proxy(client, {
          get(target, key) {
            if (key === "query") {
              return async (...args) => {
                await guard?.begin();
                return Reflect.apply(target.query.bind(target), target, args);
              };
            }
            return Reflect.get(target, key, target);
          },
        }),
        logger: {
          logQuery(...args) {
            guard?.check();
            logger?.logQuery(...args);
          },
        },
      }),
      query: client.query.bind(client),
      release() {},
    }),
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
