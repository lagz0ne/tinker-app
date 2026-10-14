import { tag } from "@tinker/core";

export { backendStop } from "~/base/server";

export const requestStop = tag<AbortSignal>({ label: "lifetime.requestStop" });
