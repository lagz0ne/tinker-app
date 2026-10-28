import { resource } from "@tinker/core";

export const betterAuthModule = resource({
  label: "module:better-auth",
  target: "scope",
  factory: () => import("better-auth"),
});

export const betterAuthStart = resource({
  label: "module:better-auth/tanstack-start",
  target: "scope",
  factory: () => import("better-auth/tanstack-start"),
});

/** Better Auth's Kysely adapter owns the SQL over `node:sqlite`, so Kysely is a dep. */
export const kyselyModule = resource({
  label: "module:kysely",
  target: "scope",
  factory: () => import("kysely"),
});

export const nodeSqliteDialect = resource({
  label: "module:@better-auth/kysely-adapter/node-sqlite-dialect",
  target: "scope",
  factory: () => import("@better-auth/kysely-adapter/node-sqlite-dialect"),
});
