import { tag } from "@tinker/core";
/** The process environment, copied once by the server entry; each reader checks its own keys. */
export const env = tag<Readonly<Record<string, string | undefined>>>({ label: "tinker.env" });
