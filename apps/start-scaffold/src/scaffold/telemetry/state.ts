import { tag } from "@tinker/core";
import type { Telemetry } from "./index.ts";
export const frontendSpans = tag<() => Telemetry.Row[]>({ label: "frontend.spans" });
