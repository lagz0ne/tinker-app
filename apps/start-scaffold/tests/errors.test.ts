import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

import type { Errors } from "~/components/errors";

/** A settled Cancelled failure, read the way app code reads a managed error. */
const cancelledShape = z.object({ kind: z.literal("Cancelled"), payload: z.strictObject({}) });

const cancel = operation({
  label: "test.cancel",
  run: (_deps, { raise }) => raise("Cancelled", {} satisfies Errors.Payloads["Cancelled"]),
});

test("zod reads a raised managed error: an Error with own kind and payload", async () => {
  const root = createScope();
  const result = root.settle(cancel);
  if (result.status !== "failed") throw result;

  expect(result.error).toBeInstanceOf(Error);
  expect(result.kind).toBe("error");
  expect(cancelledShape.safeParse(result.error)).toEqual({
    success: true,
    data: { kind: "Cancelled", payload: {} },
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("managed errors from another owner agree by kind without sharing constructors", () => {
  const foreign = Object.assign(new Error("foreign failure"), { kind: "Cancelled", payload: {} });
  expect(cancelledShape.safeParse(foreign).success).toBe(true);
});

test("the shape refuses a different kind and a missing payload", () => {
  const other = Object.assign(new Error("StreamDenied"), { kind: "StreamDenied", payload: {} });
  expect(cancelledShape.safeParse(other).success).toBe(false);
  expect(cancelledShape.safeParse(new Error("Cancelled")).success).toBe(false);
  expect(cancelledShape.safeParse(undefined).success).toBe(false);
});
