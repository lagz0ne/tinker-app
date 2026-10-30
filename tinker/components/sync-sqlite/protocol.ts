import { z } from "zod";

/** Where a tab's stream resumes: the public revision, and its account's private one. */
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
  /** Streams copy the bytes and cursor values; neither retained value leaves the cache. */
  type Frame = { cursor: Cursor; count: number; bytes: Uint8Array };
}

/** The two places a cursor can come from, each bounded before it is read. */
export const streamRequest = z.object({
  search: z.string().max(2048),
  lastEventId: z.string().max(2048).nullable(),
});
