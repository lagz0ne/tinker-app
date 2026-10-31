import { operation, tag } from "@tinker/core";
import { z } from "zod";

import { auth } from "./auth.server";
import { betterAuthApi, betterAuthOAuth2, oauthProviderModule } from "./modules";
import { authMcp, authSettings } from "./settings.server";

/** The person and OAuth client an MCP call speaks for; the app binds it per call. */
export const mcpCaller = tag({
  label: "auth.mcpCaller",
  parse: z.object({
    userId: z.string().min(1),
    clientId: z.string().min(1),
    scopes: z.array(z.string()),
  }),
});

/** The claims a checked access token must carry; `scope` is a space-separated list. */
const tokenClaims = z.object({
  sub: z.string().min(1),
  azp: z.string().min(1),
  scope: z.string().default(""),
});

/** The user and the OAuth client a token names must both exist; the client must be enabled. */
const liveRows = z.object({
  user: z.object({ id: z.string() }),
  client: z.object({
    disabled: z
      .boolean()
      .nullable()
      .optional()
      .refine((off) => !off),
  }),
});

/**
 * The parts of an MCP request a token check reads, as Better Auth's `requestToResourceInput`
 * names them. The route reads them off its `Request`; replies stay with the route too.
 */
export const checkMcpTokenInput = z.object({
  authorizationHeader: z.string().nullable(),
  dpopProofJwt: z.string().nullable(),
  method: z.string(),
  url: z.url(),
});

/**
 * Check the bearer token of an MCP request: Better Auth's own resource-server steps
 * (`verifyAccessTokenRequest` in `@better-auth/mcp`'s `createMcpProtectedRequestHandler`), with
 * the key set read from this auth instance instead of fetched over HTTP from our own `/jwks`.
 * The answer is the caller, or the challenge for the route to send: the RFC 9728 401 (403 for a
 * missing scope), with the same headers and JSON-RPC body `@better-auth/mcp` sends.
 */
export const checkMcpToken = operation({
  label: "auth.checkMcpToken",
  input: checkMcpTokenInput,
  depends: {
    auth,
    settings: authSettings,
    mcp: authMcp,
    api: betterAuthApi,
    oauth2: betterAuthOAuth2,
    provider: oauthProviderModule,
  },
  run: async ({ auth, settings, mcp, api, oauth2, provider }, { input }) => {
    const { APIError } = api;

    const resource = new URL(mcp.path, settings.origin).href;

    // offline_access is for the token endpoint (a refresh token), not for the resource.
    const required = mcp.scopes.filter((scope) => scope !== "offline_access");

    const context = await auth.$context;

    try {
      const authorization = oauth2.parseAccessTokenAuthorization(input.authorizationHeader) ?? {
        scheme: "Unknown",
        token: "",
      };

      if (authorization.scheme === "Unknown") {
        throw new APIError("UNAUTHORIZED", { message: "missing authorization header" });
      }

      // Read before the check, so a failure inside the check is the token's, not the database's.
      const keys = await auth.api.getJwks();

      const payload = await oauth2
        .verifyJwsAccessToken(authorization.token, {
          jwksFetch: async () => keys,
          verifyOptions: {
            issuer: context.baseURL,
            audience: resource,
            requiredClaims: ["exp", "iat"],
          },
        })
        .catch(() => {
          throw new APIError("UNAUTHORIZED", { message: "invalid access token" });
        });

      // A token with no person behind it (no `sub`) speaks for no one here.
      const claims = tokenClaims.safeParse(payload);

      if (!claims.success) {
        throw new APIError("UNAUTHORIZED", { message: "access token names no user" });
      }

      // The token is a JWT with no store behind it: one read stops a deleted user or client, and
      // a disabled client, at once. A sign-out or a revoke ends at the token's 5-minute end.
      const [user, client] = await Promise.all([
        context.internalAdapter.findUserById(claims.data.sub),
        context.adapter.findOne({
          model: "oauthClient",
          where: [{ field: "clientId", value: claims.data.azp }],
        }),
      ]);

      if (!liveRows.safeParse({ user, client }).success) {
        throw new APIError("UNAUTHORIZED", {
          message: "access token speaks for no live user or app",
        });
      }

      const scopes = claims.data.scope.split(" ").filter(Boolean);

      const missing = required.filter((scope) => !scopes.includes(scope));

      if (missing.length > 0) throw oauth2.createInsufficientScopeError(missing);

      await oauth2
        .enforceDpopBinding({
          payload,
          authorization,
          proofJwt: input.dpopProofJwt,
          method: input.method,
          url: input.url,
          replayStore: oauth2.createDpopReplayStore(context.internalAdapter),
        })
        .catch((error: unknown) => {
          if (!oauth2.isDpopBindingError(error)) throw error;

          throw new APIError("UNAUTHORIZED", {
            message: error.message,
            error: error.code,
            error_description: error.message,
          });
        });

      return {
        caller: { userId: claims.data.sub, clientId: claims.data.azp, scopes },
      };
    } catch (error) {
      const challenge = provider.createResourceServerChallenge(error, resource, {
        challengeScopes: required,
      });

      if (!challenge) throw error;

      const headers = new Headers(challenge.headers);

      headers.set("Content-Type", "application/json");

      return {
        challenge: {
          status: challenge.statusCode,
          headers: Object.fromEntries(headers),
          body: { jsonrpc: "2.0", error: { code: -32000, message: challenge.message }, id: null },
        },
      };
    }
  },
});
