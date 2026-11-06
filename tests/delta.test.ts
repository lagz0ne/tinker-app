import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { protocol } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";

import { keepDates } from "./fixtures/todo/codec";

// Whole or delta pushes: the transport's choice. remoteData always hands over the whole value.

/** The protocol's delta steps: plain text work, so they outlive the root that made them. */
const root = createScope({});
const { delta } = root.resolve(protocol);
await root.close();

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

test("a delta is the changed text span; applied to the last text it gives the next", () => {
  const steps = ["", "[1,2,3]", "[1,2,3,4]", "[0,1,2,3,4]", "[0,1,9,3,4]", "[]", ""];
  let last = "";
  for (const next of steps) {
    last = delta.apply(last, delta.between(last, next));
    expect(last).toBe(next);
  }
  expect(delta.between("[1,2,3]", "[1,2,3,4]")).toEqual({ at: 6, cut: 0, add: ",4" });
});

test("100 todos, one more: whole sends all of them again; delta sends one todo", async () => {
  const todo = z.object({ id: z.string(), title: z.string(), at: z.date() });
  const todos = data({ initial: [] as z.infer<typeof todo>[], parse: z.array(todo) });
  const board = remoteData({ todos });
  const add = operation({
    label: "add",
    input: z.string(),
    depends: { list: todos.controller },
    run: async ({ list }, { input }) =>
      list.set([...list.get(), { id: input, title: `Todo ${input}`, at: new Date(0) }]),
  });
  const server = createScope({
    capsules: [board({ serve: true }), memory.server({ codec: keepDates, services: [board] })],
  });
  await server.ready;
  closers.push(() => server.close());
  for (let i = 0; i < 100; i++) await server.run(add, { input: String(i) });

  const watch = (meta: Record<string, string>) => {
    const texts: string[] = [];
    const left = new AbortController();
    closers.push(() => left.abort());
    void server.run(memory.server.serveStream, {
      input: {
        address: "todos",
        text: "null",
        meta,
        push: (t: string) => void texts.push(t),
        left: left.signal,
      },
    });
    return texts;
  };
  const whole = watch({});
  const deltas = watch({ "a-im": "text-delta" });
  await new Promise((r) => setTimeout(r, 20));
  await server.run(add, { input: "100" });
  await new Promise((r) => setTimeout(r, 20));

  const sizes = { whole: whole.map((t) => t.length), delta: deltas.map((t) => t.length) };
  console.log("push sizes (chars):", JSON.stringify(sizes));
  expect(sizes.whole[1]!).toBeGreaterThan(5000); // 101 todos again
  expect(sizes.delta[1]!).toBeLessThan(300); // one todo, plus the envelope and the trace header
  // The last delta text, applied in order, is the same value as the last whole push.
  let text = "";
  for (const t of deltas) {
    text = delta.apply(
      text,
      (keepDates.deserialize(t) as { delta: { at: number; cut: number; add: string } }).delta,
    );
  }
  expect(keepDates.deserialize(text)).toEqual(
    (keepDates.deserialize(whole.at(-1)!) as { value: unknown }).value,
  );
});
