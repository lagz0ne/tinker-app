import { resource } from "@tinker/core";

export const betterAuthModule = resource({
  label: "module:better-auth",
  target: "scope",
  factory: () => import("better-auth"),
});

export const betterAuthStart = resource({
  label: "module:better-auth/tanstack-start",
  target: "scope",
  factory: () => import("better-auth/tanstack-start"),
});

/** Better Auth's Kysely adapter owns the SQL over `node:sqlite`, so Kysely is a dep. */
export const kyselyModule = resource({
  label: "module:kysely",
  target: "scope",
  factory: () => import("kysely"),
});

export const nodeSqliteDialect = resource({
  label: "module:@better-auth/kysely-adapter/node-sqlite-dialect",
  target: "scope",
  factory: () => import("@better-auth/kysely-adapter/node-sqlite-dialect"),
});

/** Endpoints, hooks, and errors for the component's own small plugins. */
export const betterAuthApi = resource({
  label: "module:better-auth/api",
  target: "scope",
  factory: () => import("better-auth/api"),
});

/** `setSessionCookie`: a code sign-in sets the same cookie as a password sign-in. */
export const betterAuthCookies = resource({
  label: "module:better-auth/cookies",
  target: "scope",
  factory: () => import("better-auth/cookies"),
});

/** The resource-server half: check an access token against a key set we hold. */
export const betterAuthOAuth2 = resource({
  label: "module:better-auth/oauth2",
  target: "scope",
  factory: () => import("better-auth/oauth2"),
});

/** Signs the OAuth access tokens; its key set checks them. */
export const jwtModule = resource({
  label: "module:better-auth/plugins/jwt",
  target: "scope",
  factory: () => import("better-auth/plugins/jwt"),
});

/** RFC 8628: the `deviceCode` table, user codes, and the one-use redeem. */
export const deviceAuthorizationModule = resource({
  label: "module:better-auth/plugins/device-authorization",
  target: "scope",
  factory: () => import("better-auth/plugins/device-authorization"),
});

/** The OAuth 2.1 provider set up for MCP, with RFC 9728 metadata. */
export const mcpModule = resource({
  label: "module:@better-auth/mcp",
  target: "scope",
  factory: () => import("@better-auth/mcp"),
});

/** The provider under `mcp()`: its RFC 9728 challenge for a refused token. */
export const oauthProviderModule = resource({
  label: "module:@better-auth/oauth-provider",
  target: "scope",
  factory: () => import("@better-auth/oauth-provider"),
});
