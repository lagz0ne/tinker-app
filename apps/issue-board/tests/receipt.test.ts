import { createScope, operation } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { readReceipt } from "@/transport/result.server";

const executionId = "10000000-0000-4000-8000-000000000001";

/** A write that refuses the way the app's writes do: Core's raise with its kind and payload. */
const refusedWrite = operation({
  label: "test.refusedWrite",
  input: z.object({ kind: z.string(), payload: z.record(z.string(), z.string()) }),
  run: (_deps, { input, raise }) => raise(input.kind, input.payload),
});

test("an accepted write becomes an accepted receipt with its execution ID", () => {
  const root = createScope({ observe: { history: 4 } });
  expect(root.run(readReceipt, { input: { status: "success", value: { executionId } } })).toEqual({
    kind: "accepted",
    executionId,
  });
  expect(root.spans().map(({ name }) => name)).toEqual(["transport.receipt"]);
});

test("a refused input shows its own reason", () => {
  const root = createScope();
  const refused = root.settle(refusedWrite, {
    input: { kind: "BadInput", payload: { reason: "Use a name with 1 to 80 letters." } },
  });
  expect(root.run(readReceipt, { input: refused })).toEqual({
    kind: "rejected",
    message: "Use a name with 1 to 80 letters.",
  });
});

test.each([
  ["TeamChanged", "Team membership changed. Try again."],
  ["IssueConflict", "Someone changed this issue first. Check the board and try again."],
  ["InvalidPosition", "That position changed. Try the move again."],
  ["IssueMissing", "That issue is not in this team."],
  ["InvalidAssignee", "Choose a member of this team."],
  ["SignInRequired", "Sign in to change private records."],
  ["NotTeamMember", "You are not on that team."],
  ["TeamAdminRequired", "Only a team admin can add members."],
  ["TeamKeyTaken", "That team key is taken."],
  ["UserNotFound", "That email needs an account first."],
  ["TodoMissing", "That todo is not in your list."],
  ["RetryNotAvailable", "There is no failed notification to retry."],
  ["StreamDenied", "That execution is not in your stream."],
])("a %s refusal shows its fixed message", (kind, message) => {
  const root = createScope();
  const refused = root.settle(refusedWrite, { input: { kind, payload: {} } });
  expect(root.run(readReceipt, { input: refused })).toEqual({
    kind: "rejected",
    message,
  });
});

test("a cancelled write raises the base's Cancelled from the receipt", () => {
  const root = createScope();
  expect(
    root.settle(readReceipt, { input: { status: "cancelled", reason: "stop" } }),
  ).toMatchObject({
    status: "failed",
    kind: "error",
    error: expect.objectContaining({ kind: "Cancelled", payload: {} }),
    origin: { label: "transport.receipt" },
  });
});

test("any other failure is the server's own error, never a shown refusal", async () => {
  const root = createScope();
  const stored = root.settle(refusedWrite, { input: { kind: "StoredDataInvalid", payload: {} } });
  if (stored.status !== "failed") return expect.unreachable("the write must fail");
  expect(() => root.run(readReceipt, { input: stored })).toThrow(
    expect.objectContaining({ kind: "StoredDataInvalid", payload: {} }),
  );

  const request = root.createSession();
  const panic = new Error("database down");
  expect(() => request.run(readReceipt, { input: { status: "failed", error: panic } })).toThrow(
    panic,
  );
  await request.close();
  expect((await root.close({ graceful: true })).status).toBe("success");
});
