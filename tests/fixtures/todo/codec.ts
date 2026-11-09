import type { transport } from "@tinker/core";

type Codec = transport.Codec;

/** JSON that keeps a Date a Date. Both sides give it to the protocol. */
export const keepDates: Codec = {
  serialize: (value) =>
    JSON.stringify(value ?? null, function (this: Record<string, unknown>, key, v) {
      return this[key] instanceof Date ? { $date: v } : v;
    }),
  deserialize: (text) =>
    JSON.parse(text, (_key, v) =>
      v && typeof v === "object" && "$date" in v ? new Date(v.$date) : v,
    ),
};
