import { resource } from "@tinker/core";

export const betterAuthReact = resource({
  label: "module:better-auth/react",
  target: "scope",
  factory: () => import("better-auth/react"),
});
