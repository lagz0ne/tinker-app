import { z } from "zod";

export const credentials = z.object({
  mode: z.enum(["signup", "signin"]),
  name: z.string().max(80),
  email: z.email(),
  password: z.string().min(8),
});
