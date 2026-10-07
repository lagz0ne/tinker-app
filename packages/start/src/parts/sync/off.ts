import { resource } from "@tinker/core";
import type { SyncPart } from "./part";

/** The sync part, off: no extensions, no router options, and nothing bound to the page. */
export const sync: SyncPart.Router<Record<never, never>> = {
  extensions: [],
  router: resource({
    label: "sync.off.router",
    factory: async () => ({ options: {}, bind: () => {} }),
  }),
};
