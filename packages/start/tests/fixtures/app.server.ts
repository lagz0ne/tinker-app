import { operation, resource } from "@tinker/core";
import type { Many, Scope } from "@tinker/core";

/**
 * A stand-in server seam for the base's own tests and type check, as `#tinker/app.server`:
 * the names the auth part reads. Its auth library echoes each request it is handed.
 */
export const extensions: Many<Scope.Extension<unknown>> = [];
export const auth = resource({
  label: "test.auth",
  factory: () => ({
    handler: async (request: Request) =>
      Response.json({ method: request.method, path: new URL(request.url).pathname }),
  }),
});
export const readAccount = operation({ label: "test.readAccount", run: () => null });
