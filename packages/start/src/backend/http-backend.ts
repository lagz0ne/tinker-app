import { tag } from "@tinker/core";

/** The one way out for HTTP the base sends itself; tests bind a fake (ADR 0102). */
export const httpBackend = tag<typeof fetch>({
  label: "http.backend",
  default: (input, init) => fetch(input, init),
});
