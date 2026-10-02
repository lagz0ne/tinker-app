import { z } from "zod";
import { raise } from "../errors.ts";
const credentials = z.object({
  mode: z.enum(["signup", "signin"]),
  name: z.string().max(80),
  email: z.email(),
  password: z.string().min(8),
});
export function readCredentials(raw: unknown) {
  const parsed = credentials.safeParse(raw);
  if (!parsed.success) raise("BadInput", { reason: "Check your email and password." });
  return parsed.data;
}
