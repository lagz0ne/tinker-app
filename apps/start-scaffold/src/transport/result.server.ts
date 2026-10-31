import { operation } from "@tinker/core";
import { z } from "zod";

import { requestStop } from "~/components/requests";
import { readExecution, readRetry } from "~/components/sync";

import { incrementCounter } from "@/demo/backend/counter.server";
import { readProfile, retryNotification, saveProfile } from "@/demo/backend/profile.server";
import { changeTodo, listTodos } from "@/demo/backend/todos.server";
import { readProfileCommand, readTodoCommand } from "@/demo/contracts/commands";
import type { Errors } from "@/demo/errors";

/** A settled write, as the server function's `settle` returns it. */
const settledWrite = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), value: z.object({ executionId: z.string() }) }),
  z.object({ status: z.literal("failed"), error: z.unknown() }),
  z.object({ status: z.literal("cancelled"), reason: z.unknown() }),
]);

/** A refused input shows its own reason. */
const badInput = z.object({
  kind: z.literal("BadInput" satisfies Errors.Name),
  payload: z.object({ reason: z.string() }),
});

/** Any other managed failure, read by its kind. */
const managed = z.object({ kind: z.string() });

/** The refusals a browser shows, by kind; any other failure stays the server's error. */
const rejections: Partial<Record<string, string>> = {
  SignInRequired: "Sign in to change private records.",
  TodoMissing: "That todo is not in your list.",
  RetryNotAvailable: "There is no failed notification to retry.",
  StreamDenied: "That execution is not in your stream.",
} satisfies Partial<Record<Errors.Name, string>>;

/** One settled write becomes its network receipt: accepted, a shown refusal, or its own failure. */
export const readReceipt = operation({
  label: "transport.receipt",
  input: settledWrite,
  run: (_deps, { input, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    if (input.status === "success") {
      return { kind: "accepted" as const, executionId: input.value.executionId };
    }

    if (input.status === "cancelled") {
      return raise("Cancelled", {});
    }

    const refused = badInput.safeParse(input.error);
    if (refused.success) return { kind: "rejected" as const, message: refused.data.payload.reason };

    const kind = managed.safeParse(input.error);
    const message =
      kind.success && Object.hasOwn(rejections, kind.data.kind)
        ? rejections[kind.data.kind]
        : undefined;
    if (message !== undefined) return { kind: "rejected" as const, message };

    throw input.error;
  },
});

/** A counter step and its receipt. One request call, so a closing request still gets it. */
export const counterReceipt = operation({
  label: "transport.counterReceipt",
  input: readExecution,
  depends: {
    write: incrementCounter.controller,
    receipt: readReceipt.controller,
    stop: requestStop.required,
  },
  run: async ({ write, receipt, stop }, { input }) =>
    receipt.run({ input: await write.settle({ input, signal: stop }) }),
});

/** A saved name and its receipt. One request call, so a closing request still gets it. */
export const profileReceipt = operation({
  label: "transport.profileReceipt",
  input: readProfileCommand,
  depends: {
    write: saveProfile.controller,
    receipt: readReceipt.controller,
    stop: requestStop.required,
  },
  run: async ({ write, receipt, stop }, { input }) =>
    receipt.run({ input: await write.settle({ input, signal: stop }) }),
});

/** A notification retry and its receipt. One request call, so a closing request still gets it. */
export const retryReceipt = operation({
  label: "transport.retryReceipt",
  input: readRetry,
  depends: {
    write: retryNotification.controller,
    receipt: readReceipt.controller,
    stop: requestStop.required,
  },
  run: async ({ write, receipt, stop }, { input }) =>
    receipt.run({ input: await write.settle({ input, signal: stop }) }),
});

/** A todo change and its receipt. One request call, so a closing request still gets it. */
export const todoReceipt = operation({
  label: "transport.todoReceipt",
  input: readTodoCommand,
  depends: {
    write: changeTodo.controller,
    receipt: readReceipt.controller,
    stop: requestStop.required,
  },
  run: async ({ write, receipt, stop }, { input }) =>
    receipt.run({ input: await write.settle({ input, signal: stop }) }),
});

/** The signed-in profile, read for one request. A cancel raises Cancelled; a failure stays as is. */
export const profileRead = operation({
  label: "transport.profileRead",
  depends: { read: readProfile.controller, stop: requestStop.required },
  run: async ({ read, stop }, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const result = await read.settle({ signal: stop });

    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return raise("Cancelled", {});
    return result.value;
  },
});

/** The signed-in todo list, read for one request. A cancel raises Cancelled; a failure stays as is. */
export const todoList = operation({
  label: "transport.todoList",
  depends: { read: listTodos.controller, stop: requestStop.required },
  run: async ({ read, stop }, { raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const result = await read.settle({ signal: stop });

    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return raise("Cancelled", {});
    return result.value;
  },
});
