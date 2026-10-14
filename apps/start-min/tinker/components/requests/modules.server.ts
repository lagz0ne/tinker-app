import { resource } from "@tinker/core";

export const startServer = resource({
  label: "module:@tanstack/react-start/server",
  target: "scope",
  factory: () => import("@tanstack/react-start/server"),
});
