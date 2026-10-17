import { extension, tag } from "@tinker/core";
import { z } from "zod";

export declare namespace Auth {
  type Settings = { origin: string; secret: string };
}

export const authSettings = tag<Auth.Settings>({
  label: "auth.settings",
  parse: z.object({ origin: z.url({ protocol: /^https?$/ }), secret: z.string().min(32) }),
});

/** Check the required auth config before serving. */
export const authStartup = extension({
  label: "auth",
  hooks: {
    async start(event) {
      event.resolve(authSettings);

      await event.next();
    },
  },
});
