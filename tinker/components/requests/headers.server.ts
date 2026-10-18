import { tag } from "@tinker/core";

/** Only request wiring and auth borrow the raw headers; app operations use principal. */
export const requestHeaders = tag<Headers>({ label: "request.headers" });
