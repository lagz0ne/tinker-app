import { z } from "zod";

import { raise } from "~/components/demo/errors";

export declare namespace Profile {
  type Value = { id: string; name: string; email: string; emailVerified: boolean };
  type Input = { name: string };
}

const profileInput = z.object({ name: z.string().trim().min(1).max(80) }).strict();

/** The schema keeps the same managed refusal at each input door. */
export const readProfileInput = profileInput.catch(() =>
  raise("BadInput", { reason: "Use a name with 1 to 80 letters." }),
);
