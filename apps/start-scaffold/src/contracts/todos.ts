import { z } from "zod";
import { raise } from "../errors.ts";
export declare namespace Todos {
  type Row = { id: number; title: string; done: boolean };
  type Change = z.infer<typeof todoChange>;
}
const todoChange = z.discriminatedUnion("kind", [
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
/**
 * @param raw - From the todo command or form; why: validate one todo change.
 */
export function readTodoChange(raw: unknown): Todos.Change {
  const result = todoChange.safeParse(raw);
  if (!result.success)
    raise("BadInput", { reason: "Use a title with 1 to 200 characters and a valid todo change." });
  return result.data;
}
