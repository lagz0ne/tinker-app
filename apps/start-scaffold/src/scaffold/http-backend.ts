import { tag } from "@tinker/core";

/** Tests bind this tag; app code sends through httpRequest instead. */
export const httpBackend = tag<typeof fetch>({
  label: "http.backend",
  default: (input, init) => fetch(input, init),
});
