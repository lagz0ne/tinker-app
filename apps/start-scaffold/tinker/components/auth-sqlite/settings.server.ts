import { extension, tag } from "@tinker/core";
import { z } from "zod";

export const authSettings = tag({
  label: "auth.settings",
  parse: z.object({ origin: z.url({ protocol: /^https?$/ }), secret: z.string().min(32) }),
});

/**
 * OAuth for the app's MCP server: its path on the origin, the scopes a token may hold, and the
 * redirect URIs a client may register (the listed ones, and loopback `/callback` when on).
 * The default fits Claude; an app binds its own to change it.
 */
export const authMcp = tag({
  label: "auth.mcp",
  parse: z.object({
    path: z.string().regex(/^\//),
    scopes: z.array(z.string().min(1)).min(1),
    redirects: z.array(z.url()),
    loopback: z.boolean(),
    loginPage: z.string().regex(/^\//),
    consentPage: z.string().regex(/^\//),
  }),
  default: {
    path: "/mcp",
    scopes: ["mcp", "offline_access"],
    redirects: [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
    ],
    loopback: true,
    loginPage: "/signin",
    consentPage: "/consent",
  },
});

/**
 * Better Auth's rate limiter: on in production by its own default, off elsewhere. Bind
 * `{ enabled: true }` to turn it on anywhere (a test of the limits does); `false` turns it off.
 */
export const authRateLimit = tag({
  label: "auth.rateLimit",
  parse: z.object({ enabled: z.boolean().optional() }),
  default: {},
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
