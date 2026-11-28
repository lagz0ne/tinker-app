import { z } from "zod";

/** One mail: who gets it, its subject and its body. */
export const letter = z.object({ to: z.string(), subject: z.string(), body: z.string() });

export type Letter = z.infer<typeof letter>;
