import { z } from "zod";

export const teamRecord = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
});

export type Team = z.infer<typeof teamRecord>;

export const teamChange = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      key: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{1,9}$/),
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("addMember"), teamId: z.uuid(), email: z.email().trim() }).strict(),
]);

export const teamCommand = z.object({ executionId: z.uuid(), change: teamChange }).strict();
export const teamInput = z.object({ teamId: z.uuid() }).strict();
