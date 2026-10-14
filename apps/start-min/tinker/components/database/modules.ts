import { resource } from "@tinker/core";

export const postgres = resource({
  label: "module:pg",
  target: "scope",
  factory: () => import("pg"),
});

export const drizzlePostgres = resource({
  label: "module:drizzle-orm/node-postgres",
  target: "scope",
  factory: () => import("drizzle-orm/node-postgres"),
});

export const drizzlePgCore = resource({
  label: "module:drizzle-orm/pg-core",
  target: "scope",
  factory: () => import("drizzle-orm/pg-core"),
});

export const drizzleMigrator = resource({
  label: "module:drizzle-orm/migrator",
  target: "scope",
  factory: () => import("drizzle-orm/migrator"),
});

export const drizzleOrm = resource({
  label: "module:drizzle-orm",
  target: "scope",
  factory: () => import("drizzle-orm"),
});
