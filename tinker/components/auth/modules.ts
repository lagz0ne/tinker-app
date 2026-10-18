import { resource } from "@tinker/core";

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
