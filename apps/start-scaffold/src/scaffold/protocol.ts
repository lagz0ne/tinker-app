import { z } from "zod";
const cursor = z
  .object({
    public: z.number().int().min(0),
    private: z
      .object({ accountId: z.string().min(1), revision: z.number().int().min(0) })
      .strict()
      .nullable(),
  })
  .strict();
export declare namespace Stream {
  type Cursor = z.infer<typeof cursor>;
}
export const readStreamCursor = (raw: unknown) => cursor.parse(raw);
const request = z.object({
  search: z.string().max(2048),
  lastEventId: z.string().max(2048).nullable(),
});
/** Last-Event-ID is only a cursor; the server separately authorizes its private account. */
export function readStreamRequest(raw: unknown) {
  const { search, lastEventId } = request.parse(raw);
  const supplied = lastEventId || new URLSearchParams(search).get("cursor");
  return cursor.parse(supplied ? JSON.parse(supplied) : { public: 0, private: null });
}
