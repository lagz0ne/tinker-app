import { z } from "zod";

export declare namespace Todos {
  type Row = { id: number; title: string; done: boolean };
  type Change = z.infer<typeof readTodoChange>;
}

/** The change a todo save accepts; the operation that parses it raises the refusal. */
export const readTodoChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), title: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal("setDone"),
      id: z.number().int().positive().max(2_147_483_647),
      done: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal("delete"), id: z.number().int().positive().max(2_147_483_647) })
    .strict(),
]);

/** The BadInput reason for a change the contract refuses. */
export const todoRefusal = "Use a title with 1 to 200 characters and a valid todo change.";
