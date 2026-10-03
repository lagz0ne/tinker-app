import { z } from "zod";
export const streamCursor = z
  .object({
    public: z.number().int().min(0),
    private: z
      .object({ accountId: z.string().min(1), revision: z.number().int().min(0) })
      .strict()
      .nullable(),
  })
  .strict();
export declare namespace Stream {
  type Cursor = z.infer<typeof streamCursor>;
}
export const streamRequest = z.object({
  search: z.string().max(2048),
  lastEventId: z.string().max(2048).nullable(),
});
