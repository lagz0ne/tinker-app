import { tag } from "@tinker/core";

/**
 * The one way out for HTTP the base sends itself; tests bind a fake (ADR 0102). Its default is
 * the real `fetch`: an effect default on the seam, as ADR 0113 allows.
 */
export const httpBackend = tag<typeof fetch>({
  label: "http.backend",
  default: (input, init) => fetch(input, init),
});
