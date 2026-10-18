import { createScope, type Scope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { checkClosed } from "~/base/main";
import { observeServerPanics } from "~/base/panics.server";
import { renderFrames, renderLifetime } from "~/components/requests/render-lifetime.server";

test("checkClosed keeps failure before teardown and accepts an empty teardown list", () => {
  const failed = new Error("work failed");
  const cleanup = new Error("close failed");
  const second = new Error("later close failed");

  expect(() => checkClosed({ status: "success" } as Scope.Result)).not.toThrow();
  expect(() =>
    checkClosed({ status: "success", teardownErrors: [] } as unknown as Scope.Result),
  ).not.toThrow();
  expect(() =>
    checkClosed({
      status: "failed",
      error: failed,
      teardownErrors: [cleanup],
    } as unknown as Scope.Result),
  ).toThrow(failed);
  expect(() =>
    checkClosed({
      status: "success",
      teardownErrors: [cleanup, second],
    } as unknown as Scope.Result),
  ).toThrow(cleanup);
});

for (const phase of ["work", "close"] as const) {
  test(`server panic observer reports ${phase} cleanup failure and unhooks itself`, async () => {
    const prior = new Set(process.listeners("unhandledRejection"));
    const reason = new Error("unhandled work");
    const cleanup = new Error("cleanup refused");
    const closed = Promise.withResolvers<void>();
    const output: string[] = [];
    const aborted: unknown[] = [];
    const remove = observeServerPanics(
      (error) => {
        aborted.push(error);
        if (phase === "work") throw cleanup;
      },
      closed.promise,
      { write: (chunk) => output.push(chunk) },
    );
    const listener = process.listeners("unhandledRejection").find((held) => !prior.has(held))!;

    try {
      const running = listener(reason, Promise.resolve());
      if (phase === "close") {
        expect(output).toEqual([]);
        closed.reject(cleanup);
      }
      await Promise.resolve(running);

      expect(aborted).toEqual([reason]);
      expect(output).toHaveLength(1);
      expect(output[0]).toContain("server close failed: Error: cleanup refused");
      expect(output[0]!.endsWith("\n")).toBe(true);
      remove();
      expect(process.listeners("unhandledRejection")).not.toContain(listener);
    } finally {
      closed.resolve();
      if (listener) process.off("unhandledRejection", listener);
    }
  });
}

test("render close stays joined, removes its lookup, and runs once", async () => {
  const root = createScope();
  const session = root.createSession();
  const finish = Promise.withResolvers<void>();
  const request = new Request("https://page.test/");
  let closes = 0;

  try {
    const frames = root.resolve(renderFrames);

    expect(() => frames.retain(request, async () => {})).toThrow(
      expect.objectContaining({ kind: "StartScopeMissing", payload: {} }),
    );
    const lifetime = session.resolve(renderLifetime);
    lifetime.open(request);
    frames.retain(request, async () => {
      closes++;
      await finish.promise;
    });
    let done = false;
    const closing = session.close({ graceful: true }).then((result) => {
      done = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closes).toBe(1);
    expect(done).toBe(false);
    expect(() => frames.retain(request, async () => {})).toThrow(
      expect.objectContaining({ kind: "StartScopeMissing" }),
    );
    finish.resolve();
    expect((await closing).status).toBe("success");
    await session.close({ graceful: true });
    expect(closes).toBe(1);
  } finally {
    finish.resolve();
    await session.close();
    await root.close();
  }
});

test("an unused render lifetime closes without a request or retained work", async () => {
  const root = createScope();
  const session = root.createSession();
  try {
    session.resolve(renderLifetime);
    expect((await session.close({ graceful: true })).status).toBe("success");
  } finally {
    await session.close();
    await root.close();
  }
});
