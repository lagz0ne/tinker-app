import { afterEach, expect, test } from "bun:test";

import { createScope, data } from "@tinker/core";

import { remoteData } from "~/components/remote-data";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

test("a client without the capsule: reading the export fails loud (CapsuleMissing), not a silent initial", async () => {
  const todos = data({ initial: ["a"] });
  const board = remoteData({ todos });
  const bare = createScope({});
  await bare.ready;
  closers.push(async () => void (await bare.close()));
  let kind = "";
  try {
    bare.resolve(board.todos).get();
  } catch (error) {
    kind = String(Object(error).kind);
  }

  expect(kind).toBe("CapsuleMissing");
});

test("the passed cell is only a shape: each definition makes its own cell", async () => {
  const todos = data({ initial: ["a"] });
  const one = remoteData({ todos });
  const two = remoteData({ todos });

  expect(one.todos).not.toBe(two.todos);
  const scope = createScope({ capsules: [one({ serve: true }), two({ serve: true })] });
  await scope.ready;
  closers.push(async () => void (await scope.close()));
  expect([scope.resolve(one.todos).get(), scope.resolve(two.todos).get()]).toEqual([["a"], ["a"]]);
});
