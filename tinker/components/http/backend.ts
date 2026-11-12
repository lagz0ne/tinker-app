import { tag } from "@tinkered/core";

/**
 * The one way out for HTTP components send themselves; tests bind a fake (ADR 0102). Its default is
 * the real `fetch`: an effect default on the seam, as ADR 0113 allows.
 */
export const httpBackend = tag<
  (input: string | URL | Request, init?: RequestInit) => Promise<Response>
>({
  label: "http.backend",
  default: (input, init) => fetch(input, init),
});
