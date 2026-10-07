import { z } from "zod";
import { raise } from "../errors";
export declare namespace Profile {
  type Value = { id: string; name: string; email: string; emailVerified: boolean };
  type Input = { name: string };
}
const profileInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();
/**
 * @param raw - From the profile command or draft; why: validate only the saved name.
 */
export function readProfileInput(raw: unknown): Profile.Input {
  const result = profileInput.safeParse(raw);
  if (!result.success) raise("BadInput", { reason: "Use a name with 1 to 80 letters." });
  return result.data;
}
