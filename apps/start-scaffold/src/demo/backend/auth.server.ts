import { operation, resource } from "@tinker/core";

import { principal } from "~/components/auth/index.server";

import type { Errors } from "@/demo/errors";

export const currentUser = resource({
  label: "request.currentUser",
  target: "session",
  depends: { principal },
  factory: async ({ principal }, { raise }) => {
    if (principal === null) {
      return raise("SignInRequired", {} satisfies Errors.Payload<"SignInRequired">);
    }
    return principal;
  },
});

export const readAccount = operation({
  label: "readAccount",
  depends: { principal },
  run: async ({ principal }) => principal?.id ?? null,
});
