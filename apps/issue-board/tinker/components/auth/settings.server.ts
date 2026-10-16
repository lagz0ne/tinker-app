import { extension, tag } from "@tinker/core";
import { z } from "zod";

import { authCalls } from "./calls.server";
import { sendAuthMail, sessionDeleted, userCreated } from "./slots";

export declare namespace Auth {
  type Settings = { origin: string; secret: string };
}

export const authSettings = tag<Auth.Settings>({
  label: "auth.settings",
  parse: z.object({ origin: z.url({ protocol: /^https?$/ }), secret: z.string().min(32) }),
});

/** Check required config at start; retain the start context only for hooks outside a live flow. */
export const authStartup = extension({
  label: "auth",
  hooks: {
    async start(event) {
      event.resolve(authSettings);
      event.resolve(sendAuthMail);
      event.resolve(sessionDeleted);
      event.resolve(userCreated);

      await event.next();
      return event;
    },
    run(event) {
      return event.resolve(authCalls).then((calls) => calls.run(event, event.next));
    },
  },
});
