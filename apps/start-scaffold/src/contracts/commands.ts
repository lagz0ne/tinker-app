import { z } from "zod";
import { readProfileInput } from "./profile.ts";
import { readTodoChange } from "./todos.ts";
const profileCommand = z.object({ executionId: z.uuid(), profile: z.unknown() }).strict();
const todoCommand = z.object({ executionId: z.uuid(), change: z.unknown() }).strict();
export function readProfileCommand(raw: unknown) {
  const command = profileCommand.parse(raw);
  return { executionId: command.executionId, profile: readProfileInput(command.profile) };
}
export function readTodoCommand(raw: unknown) {
  const command = todoCommand.parse(raw);
  return { executionId: command.executionId, change: readTodoChange(command.change) };
}
