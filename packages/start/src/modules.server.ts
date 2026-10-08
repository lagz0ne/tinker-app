import { resource } from "@tinker/core";

export const drizzleOrm = resource({
  label: "module:drizzle-orm",
  target: "scope",
  factory: () => import("drizzle-orm"),
});

export const startServer = resource({
  label: "module:@tanstack/react-start/server",
  target: "scope",
  factory: () => import("@tanstack/react-start/server"),
});
