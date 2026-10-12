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

export const betterAuthModule = resource({
  label: "module:better-auth",
  target: "scope",
  factory: () => import("better-auth"),
});

export const betterAuthDrizzle = resource({
  label: "module:better-auth/adapters/drizzle",
  target: "scope",
  factory: () => import("better-auth/adapters/drizzle"),
});

export const betterAuthStart = resource({
  label: "module:better-auth/tanstack-start",
  target: "scope",
  factory: () => import("better-auth/tanstack-start"),
});

export const smtp = resource({
  label: "module:nodemailer",
  target: "scope",
  factory: () => import("nodemailer"),
});
