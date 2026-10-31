import { tag } from "@tinker/core";
import { z } from "zod";

/** The default and the top cap of an upload slot: 25 MiB, obelisk's `MAX_UPLOAD`. */
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

/**
 * The top cap of `putBlob`, and of a zip's unpacked total: an entry is never bigger than the
 * total. The app's zip reader reads it.
 */
export const blobUnpackMax = tag<number>({
  label: "blobs.unpackMax",
  default: 104_857_600,
  parse: z.number().int().positive(),
});
