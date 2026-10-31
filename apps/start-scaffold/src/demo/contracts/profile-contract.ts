import { z } from "zod";

export declare namespace Profile {
  type Value = { id: string; name: string; email: string; emailVerified: boolean };
  type Input = { name: string };
}

/** The name a profile save accepts; the operation that parses it raises the refusal. */
export const readProfileInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();

/** The BadInput reason for a name the contract refuses. */
export const profileRefusal = "Use a name with 1 to 80 letters.";
