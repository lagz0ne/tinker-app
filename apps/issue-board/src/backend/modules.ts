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

export const files = resource({
  label: "module:node:fs/promises",
  target: "scope",
  factory: () => import("node:fs/promises"),
});

export const csvParser = resource({
  label: "module:csv-parse/sync",
  target: "scope",
  factory: () => import("csv-parse/sync"),
});
