import { resource } from "@tinker/core";

export const blobFs = resource({
  label: "module:node:fs/promises",
  target: "scope",
  factory: () => import("node:fs/promises"),
});

export const blobCrypto = resource({
  label: "module:node:crypto",
  target: "scope",
  factory: () => import("node:crypto"),
});

export const blobPath = resource({
  label: "module:node:path",
  target: "scope",
  factory: () => import("node:path"),
});
