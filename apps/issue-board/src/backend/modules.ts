import { resource } from "@tinker/core";

export const fractionalIndex = resource({
  label: "module:fractional-indexing",
  target: "scope",
  factory: () => import("fractional-indexing"),
});

export const postgres = resource({
  label: "module:pg",
  target: "scope",
  factory: () => import("pg"),
});
