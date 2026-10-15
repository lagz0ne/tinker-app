import { operation, resource } from "@tinker/core";

import { principal } from "~/components/auth/index.server";

import { raise } from "@/demo/errors";

export const currentUser = resource({
  label: "request.currentUser",
  target: "session",
  depends: { principal },
  factory: async ({ principal }) => {
    if (principal === null) raise("SignInRequired", {});
    return principal;
  },
});

export const readAccount = operation({
  label: "readAccount",
  depends: { principal },
  run: async ({ principal }) => principal?.id ?? null,
});
