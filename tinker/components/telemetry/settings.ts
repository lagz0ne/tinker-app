import { LEVELS, tag } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

export const telemetrySide = tag({
  label: "telemetry.side",
  parse: z.enum(["server", "browser", "ssr", "worker"]),
});

export const telemetryService = tag({
  label: "telemetry.service",
  parse: z.string().min(1),
});

export const tracesUrl = tag({ label: "telemetry.tracesUrl", parse: z.instanceof(URL) });
export const logsUrl = tag({ label: "telemetry.logsUrl", parse: z.instanceof(URL) });

/** Info and 80 saved spans are safe without an app choice. */
export const logLevel = tag<Observe.Level>({
  label: "telemetry.logLevel",
  default: LEVELS.info,
  parse: z.union([z.literal(20), z.literal(30), z.literal(40), z.literal(50)]),
});

export const spanHistory = tag<number>({
  label: "telemetry.spanHistory",
  default: 80,
  parse: z.number().int().min(0),
});
