import { tag } from "@tinker/core";
import { z } from "zod";

/** The most bytes one blob may hold: 25 MiB, obelisk's `MAX_UPLOAD`. */
export const blobMaxBytes = tag<number>({
  label: "blobs.maxBytes",
  default: 26_214_400,
  parse: z.number().int().positive(),
});

/** How long an upload slot lives, in ms: one hour, as in obelisk. */
export const blobSlotTtl = tag<number>({
  label: "blobs.slotTtl",
  default: 3_600_000,
  parse: z.number().int().positive(),
});

/** The most bytes a zip may unpack to, all entries together. The app's zip reader reads it. */
export const blobUnpackMax = tag<number>({
  label: "blobs.unpackMax",
  default: 104_857_600,
  parse: z.number().int().positive(),
});
