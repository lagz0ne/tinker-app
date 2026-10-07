import { z } from "zod";
import { readProfileInput } from "./profile";
import { readTodoChange } from "./todos";
const profileCommand = z.object({ executionId: z.uuid(), profile: z.unknown() }).strict();
const todoCommand = z.object({ executionId: z.uuid(), change: z.unknown() }).strict();
/**
 * @param raw - From the profile request body; why: read its execution ID and profile input.
 */
export function readProfileCommand(raw: unknown) {
  const command = profileCommand.parse(raw);
  return { executionId: command.executionId, profile: readProfileInput(command.profile) };
}
/**
 * @param raw - From the todo request body; why: read its execution ID and todo change.
 */
export function readTodoCommand(raw: unknown) {
  const command = todoCommand.parse(raw);
  return { executionId: command.executionId, change: readTodoChange(command.change) };
}
