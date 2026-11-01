import { resource } from "@tinker/core";

/** The server's telemetry root starts its worker thread from this module. */
export const workerThreads = resource({
  label: "module:node:worker_threads",
  target: "scope",
  factory: () => import("node:worker_threads"),
});
