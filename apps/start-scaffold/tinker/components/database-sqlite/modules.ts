import { resource } from "@tinker/core";

export const sqlite = resource({
  label: "module:node:sqlite",
  target: "scope",
  factory: () => import("node:sqlite"),
});

export const sqliteFs = resource({
  label: "module:node:fs/promises",
  target: "scope",
  factory: () => import("node:fs/promises"),
});

export const sqlitePath = resource({
  label: "module:node:path",
  target: "scope",
  factory: () => import("node:path"),
});

export const sqliteUrl = resource({
  label: "module:node:url",
  target: "scope",
  factory: () => import("node:url"),
});
