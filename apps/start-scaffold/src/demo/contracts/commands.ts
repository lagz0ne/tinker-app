import { z } from "zod";

/** The profile body: one execution ID, and the profile input `saveProfile` reads. */
export const readProfileCommand = z
  .object({ executionId: z.uuid(), profile: z.unknown() })
  .strict();

/** The todo body: one execution ID, and the change `changeTodo` reads. */
export const readTodoCommand = z.object({ executionId: z.uuid(), change: z.unknown() }).strict();
