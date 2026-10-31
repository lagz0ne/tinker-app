import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { openSync } from "~/components/auth/index.server";
import { requestStop } from "~/components/requests";
import { receiveTelemetry } from "~/components/telemetry/index.server";

import { incrementCounter } from "@/demo/backend/counter.server";
import { readProfile, retryNotification, saveProfile } from "@/demo/backend/profile.server";
import { changeTodo, listTodos } from "@/demo/backend/todos.server";
import { healthRead } from "@/transport/health.server";
import {
  counterReceipt,
  profileRead,
  profileReceipt,
  retryReceipt,
  todoList,
  todoReceipt,
} from "@/transport/result.server";
import { streamOpen } from "@/transport/stream.server";
import { telemetryReceive } from "@/transport/telemetry.server";

const executionId = "10000000-0000-4000-8000-000000000001";

test("a write's receipt still comes back when the request closes while the write runs", async () => {
  const gate = Promise.withResolvers<void>();
  const root = createScope({
    presets: [
      preset(changeTodo, async () => {
        await gate.promise;
        return { executionId };
      }),
    ],
  });
  const request = root.createSession({ tags: [requestStop(new AbortController().signal)] });

  const receipt = request.run(todoReceipt, {
    input: { executionId, change: { kind: "add", title: "Task" } },
  });
  const closing = request.close({ graceful: true });
  gate.resolve();

  expect(await receipt).toEqual({ kind: "accepted", executionId });
  expect(await closing).toEqual({ status: "success" });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a write the request stops while it runs raises the base's Cancelled", async () => {
  const stop = new AbortController();
  const root = createScope({
    presets: [
      preset(changeTodo, async (_deps, { signal }) => {
        stop.abort();
        signal.throwIfAborted();
        return { executionId };
      }),
    ],
  });
  const request = root.createSession({ tags: [requestStop(stop.signal)] });

  const settled = await request.settle(todoReceipt, {
    input: { executionId, change: { kind: "add", title: "Task" } },
  });
  expect(settled).toMatchObject({
    status: "failed",
    kind: "error",
    error: expect.objectContaining({ kind: "Cancelled", payload: {} }),
    origin: { label: "transport.receipt" },
  });
  await request.close();
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("each write hands its input to the write and answers with the receipt", async () => {
  const seen: unknown[] = [];
  const accept = async (_deps: unknown, ctx: { input: unknown }) => {
    seen.push(ctx.input);
    return { executionId };
  };
  const root = createScope({
    presets: [
      preset(incrementCounter, accept),
      preset(saveProfile, accept),
      preset(retryNotification, accept),
      preset(changeTodo, accept),
    ],
  });
  const request = root.createSession({ tags: [requestStop(new AbortController().signal)] });
  const accepted = { kind: "accepted", executionId };
  const profile = { executionId, profile: { name: "Ada" } };
  const retry = { executionId, previousExecutionId: executionId };
  const change = { executionId, change: { kind: "delete", id: 1 } };

  expect(await request.run(counterReceipt, { input: { executionId } })).toEqual(accepted);
  expect(await request.run(profileReceipt, { input: profile })).toEqual(accepted);
  expect(await request.run(retryReceipt, { input: retry })).toEqual(accepted);
  expect(await request.run(todoReceipt, { input: change })).toEqual(accepted);
  expect(seen).toEqual([{ executionId }, profile, retry, change]);
  await request.close();
});

test("each read boundary returns the read's value for the request", async () => {
  const batch = { traces: [], logs: [] };
  const root = createScope({
    presets: [
      preset(listTodos, async () => [{ id: 1, title: "Task", done: false }]),
      preset(readProfile, async () => null),
      preset(receiveTelemetry, async (_deps, { input }) => {
        expect(input).toEqual(batch);
      }),
      preset(openSync, async () => new ReadableStream()),
    ],
  });
  const session = root.createSession({ tags: [requestStop(new AbortController().signal)] });

  expect(await session.run(healthRead)).toEqual({ ok: true, base: expect.any(String) });
  expect(await session.run(todoList)).toEqual([{ id: 1, title: "Task", done: false }]);
  expect(await session.run(profileRead)).toBeNull();
  expect(await session.run(telemetryReceive, { input: batch })).toBeUndefined();
  expect(
    await session.run(streamOpen, { input: { search: "", lastEventId: null } }),
  ).toBeInstanceOf(ReadableStream);
  await session.close();
});

test("each read boundary raises the base's Cancelled once the request stopped", async () => {
  const stop = new AbortController();
  stop.abort();
  const root = createScope();
  const session = root.createSession({ tags: [requestStop(stop.signal)] });
  const cancelled = (label: string) => ({
    status: "failed",
    kind: "error",
    error: expect.objectContaining({ kind: "Cancelled", payload: {} }),
    origin: { label },
  });

  expect(await session.settle(healthRead)).toMatchObject(cancelled("transport.health"));
  expect(await session.settle(todoList)).toMatchObject(cancelled("transport.todoList"));
  expect(await session.settle(profileRead)).toMatchObject(cancelled("transport.profileRead"));
  expect(await session.settle(telemetryReceive, { input: { traces: [], logs: [] } })).toMatchObject(
    cancelled("transport.telemetry"),
  );
  await session.close();
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a read's own failure passes through its boundary as is", async () => {
  const root = createScope({
    presets: [preset(listTodos, async (_deps, { raise }) => raise("StoredDataInvalid", {}))],
  });
  const session = root.createSession({ tags: [requestStop(new AbortController().signal)] });

  expect(await session.settle(todoList)).toMatchObject({
    status: "failed",
    kind: "error",
    error: expect.objectContaining({ kind: "StoredDataInvalid", payload: {} }),
    origin: { label: "listTodos" },
  });
  await session.close();
  expect((await root.close({ graceful: true })).status).toBe("success");
});
