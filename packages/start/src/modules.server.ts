import { resource } from "@tinker/core";

export const drizzleOrm = resource({
  label: "module:drizzle-orm",
  target: "scope",
  factory: () => import("drizzle-orm"),
});
