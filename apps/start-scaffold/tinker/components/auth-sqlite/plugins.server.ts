import { resource } from "@tinker/core";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";

import {
  betterAuthApi,
  betterAuthCookies,
  deviceAuthorizationModule,
  jwtModule,
  mcpModule,
} from "./modules";
import { authMcp, authSettings } from "./settings.server";

/** RFC 8628 6.1: no vowels and no look-alike letters, so a code is easy to read out. */
const letters = "BCDFGHJKLMNPQRSTVWXZ";

/** The one device client: the browser that asks for a code. */
const webClient = "web";

const deviceCookie = "tinker_device";

/** A code waits 10 minutes; at most 50 wait at once. */
const codeSeconds = 600;

const waitingCap = 50;

/** The first match names the browser; Chrome's agent also says Safari, so Chrome comes first. */
const browsers = [
  [/Edg\//, "Edge"],
  [/CriOS|Chrome\//, "Chrome"],
  [/FxiOS|Firefox\//, "Firefox"],
  [/Safari\//, "Safari"],
] as const;

const systems = [
  [/iPhone|iPad/, "iPhone or iPad"],
  [/Android/, "Android"],
  [/Mac OS X/, "Mac"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
] as const;

/**
 * Sign-in with a code, RFC 8628 turned around: the browser asks for a code and keeps the device
 * half in an httpOnly cookie, a signed-in caller approves the code (`approveSignin`), and only
 * that browser finishes. Better Auth's `deviceAuthorization` owns the table, the user codes, and
 * the one-use redeem; its public `/device*` routes are off, so these three routes are the way in.
 * The finish sets the session cookie through Better Auth, so a start from the OAuth login page
 * (with its signed `oauth_query`) goes on to the OAuth redirect through the provider's own hook.
 */
export const codeSignin = resource({
  label: "auth.codeSignin",
  target: "scope",
  depends: {
    settings: authSettings,
    api: betterAuthApi,
    cookies: betterAuthCookies,
    device: deviceAuthorizationModule,
  },
  factory: async ({ settings, api, cookies, device }) => {
    const { APIError, createAuthEndpoint } = api;
    const { setSessionCookie } = cookies;
    const { deviceAuthorization, redeemDeviceCode } = device;

    const half = {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: settings.origin.startsWith("https:"),
    } as const;

    const codes = deviceAuthorization({
      expiresIn: "10m",
      validateClient: (clientId) => clientId === webClient,
      generateUserCode: () => {
        const picked: string[] = [];

        // Drop bytes past the last whole run of 20 letters, so each letter is as likely.
        while (picked.length < 8) {
          for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
            if (byte < 240 && picked.length < 8) picked.push(letters[byte % 20]);
          }
        }

        return picked.join("");
      },
    });

    const signin = {
      id: "tinker-code-signin",
      schema: {
        deviceCode: {
          fields: {
            signinBrowser: { type: "string", required: false, input: false },
            signinNext: { type: "string", required: false, input: false },
            signinClient: { type: "string", required: false, input: false },
            signinApprovedBy: { type: "string", required: false, input: false },
          },
        },
      },
      endpoints: {
        startCodeSignin: createAuthEndpoint(
          "/signin/code",
          {
            method: "POST",
            body: z.object({
              // Obelisk's safeNext: one leading slash and no backslash, else the home page.
              next: z
                .string()
                .max(2000)
                .regex(/^\/(?!\/)[^\\]*$/)
                .catch("/"),
              oauth_query: z.string().max(8000).optional(),
            }),
            metadata: { noStore: true },
          },
          async (ctx) => {
            const { adapter } = ctx.context;

            const waiting = await adapter.count({
              model: "deviceCode",
              where: [{ field: "expiresAt", operator: "gt", value: new Date() }],
            });

            if (waiting >= waitingCap) {
              throw new APIError("TOO_MANY_REQUESTS", {
                error: "slow_down",
                error_description: "Too many codes wait now. Try again in 10 minutes.",
              });
            }

            const started = await codes.endpoints.deviceCode({
              context: ctx.context,
              headers: ctx.headers,
              body: { client_id: webClient },
            });

            // The provider's own before-hook has checked the signature of `oauth_query`.
            const query = new URLSearchParams(ctx.body.oauth_query);

            const client = await adapter.findOne<{ name?: string | null }>({
              model: "oauthClient",
              where: [{ field: "clientId", value: query.get("client_id") ?? "" }],
            });

            // The browser and system in plain words, as obelisk shows them.
            const agent = new Headers(ctx.headers).get("user-agent") ?? "";

            const [browser = "a browser"] = browsers
              .filter(([pattern]) => pattern.test(agent))
              .map(([, name]) => name);

            const [system = "a device"] = systems
              .filter(([pattern]) => pattern.test(agent))
              .map(([, name]) => name);

            // An OAuth start names its client; a plain sign-in names none.
            await adapter.update({
              model: "deviceCode",
              where: [{ field: "deviceCode", value: started.device_code }],
              update: {
                signinBrowser: `${browser} on ${system}`,
                signinNext: ctx.body.next,
                signinClient: client && (client.name ?? "an app"),
              },
            });

            ctx.setCookie(deviceCookie, started.device_code, { ...half, maxAge: codeSeconds });

            return ctx.json({
              user_code: `${started.user_code.slice(0, 4)}-${started.user_code.slice(4)}`,
              expires_in: started.expires_in,
            });
          },
        ),
        codeSigninState: createAuthEndpoint(
          "/signin/code/state",
          { method: "GET", metadata: { noStore: true } },
          async (ctx) => {
            // No device code is empty, so a missing cookie finds no row.
            const value = ctx.getCookie(deviceCookie) ?? "";

            const row = await ctx.context.adapter.findOne<{ status: string; expiresAt: Date }>({
              model: "deviceCode",
              where: [
                { field: "deviceCode", value },
                { field: "clientId", value: webClient },
              ],
            });

            if (!row || row.expiresAt <= new Date()) return ctx.json({ state: "gone" });

            return ctx.json({ state: row.status === "approved" ? "approved" : "waiting" });
          },
        ),
        finishCodeSignin: createAuthEndpoint(
          "/signin/code/finish",
          {
            method: "POST",
            body: z.object({ oauth_query: z.string().max(8000).optional() }),
            metadata: { noStore: true },
          },
          async (ctx) => {
            const value = ctx.getCookie(deviceCookie) ?? "";

            const row = await ctx.context.adapter.findOne<{
              status: string;
              expiresAt: Date;
              userCode: string;
              signinNext: string;
              signinBrowser: string | null;
              signinApprovedBy: string | null;
            }>({
              model: "deviceCode",
              where: [
                { field: "deviceCode", value },
                { field: "clientId", value: webClient },
              ],
            });

            if (!row || row.expiresAt <= new Date()) {
              ctx.setCookie(deviceCookie, "", { ...half, maxAge: 0 });
              ctx.setStatus(410);

              return ctx.json({ state: "gone" });
            }

            // Checked before the redeem: a redeem of a waiting code would start its poll interval.
            if (row.status !== "approved") {
              ctx.setStatus(409);

              return ctx.json({ state: "waiting" });
            }

            let user;

            try {
              // The one-use claim: of two finishes with one cookie, one gets the row.
              ({ user } = await redeemDeviceCode({
                ctx,
                deviceCode: value,
                authorizeRedemption: async () => ({
                  ownershipWhere: { field: "clientId", value: webClient },
                  context: undefined,
                }),
                prepareRedemption: async () => undefined,
              }));
            } catch (error) {
              if (!(error instanceof APIError)) throw error;

              ctx.setCookie(deviceCookie, "", { ...half, maxAge: 0 });
              ctx.setStatus(410);

              return ctx.json({ state: "gone" });
            }

            const session = await ctx.context.internalAdapter.createSession(user.id, false, {
              signinCode: row.userCode,
              signinBrowser: row.signinBrowser,
              signinApprovedBy: row.signinApprovedBy,
            });

            await setSessionCookie(ctx, { session, user });

            ctx.setCookie(deviceCookie, "", { ...half, maxAge: 0 });

            return ctx.json({ state: "signed_in", next: row.signinNext });
          },
        ),
      },
    } satisfies BetterAuthPlugin;

    return [codes, signin] as const;
  },
});

/**
 * Better Auth's OAuth provider for MCP: `jwt()` signs the access tokens, and `mcp()` binds them
 * to the MCP resource and serves its RFC 9728 metadata. Registration is open (DCR), so every
 * client write is checked first: each redirect URI must be listed, or loopback `/callback`.
 */
export const mcpProvider = resource({
  label: "auth.mcpProvider",
  target: "scope",
  depends: {
    settings: authSettings,
    mcp: authMcp,
    api: betterAuthApi,
    jwt: jwtModule,
    provider: mcpModule,
  },
  factory: async ({ settings, mcp, api, jwt, provider }) => {
    const { APIError, createAuthMiddleware } = api;

    const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/callback$/;

    const allowed = z
      .string()
      .refine((uri) => mcp.redirects.includes(uri) || (mcp.loopback && loopback.test(uri)));

    // A register names its redirect URIs at the top; an update may keep them, or name new ones.
    const writes = new Map<string, z.ZodType>([
      ["/oauth2/register", z.object({ redirect_uris: z.array(allowed).min(1) })],
      ["/oauth2/create-client", z.object({ redirect_uris: z.array(allowed).min(1) })],
      ["/admin/oauth2/create-client", z.object({ redirect_uris: z.array(allowed).min(1) })],
      [
        "/oauth2/update-client",
        z.object({ update: z.object({ redirect_uris: z.array(allowed).min(1).optional() }) }),
      ],
      [
        "/admin/oauth2/update-client",
        z.object({ update: z.object({ redirect_uris: z.array(allowed).min(1).optional() }) }),
      ],
    ]);

    // Claude Code and obelisk's mcp-run register a loopback redirect and name no application type.
    const untypedLoopback = z.object({
      application_type: z.undefined().optional(),
      redirect_uris: z.array(z.string().regex(loopback)).min(1),
    });

    /**
     * Better Auth's app-level hook: it sees every client write before the provider stores it.
     * A registration with only loopback redirects and no application type is a native client
     * (RFC 8252 7.3); Better Auth 1.7.7 would default it to web and refuse its redirect.
     */
    const clientCheck = createAuthMiddleware(async (ctx) => {
      const shape = writes.get(ctx.path ?? "");

      if (shape && !shape.safeParse(ctx.body).success) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_redirect_uri",
          error_description: "Each redirect URI must be one this server allows, and one is needed.",
        });
      }

      if (ctx.path === "/oauth2/register" && untypedLoopback.safeParse(ctx.body).success) {
        return { context: { body: { ...ctx.body, application_type: "native" } } };
      }
    });

    const plugins = [
      jwt.jwt(),
      provider.mcp({
        resource: new URL(mcp.path, settings.origin).href,
        scopes: mcp.scopes,
        loginPage: mcp.loginPage,
        consentPage: mcp.consentPage,
        // No client_credentials: every token speaks for a person.
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ] as const;

    return { plugins, clientCheck };
  },
});
