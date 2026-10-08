import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { abortReasons, accountOwner, tabStop } from "@tinker/start/testing";

test("closing the tab owner uses the shared abort reason", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  const first = root.resolve(accountOwner).capture().signal;
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(first.reason).toBe(abortReasons.closed);
});

test("account changes reuse one AbortError reason", async () => {
  const root = createScope({
    extensions: [accountOwner],
    tags: tabStop(new AbortController().signal),
  });
  await root.ready;
  try {
    const owner = root.resolve(accountOwner);
    const first = owner.capture().signal;
    owner.reset();
    const second = owner.capture().signal;
    owner.reset();
    expect(first.reason).toBe(abortReasons.changed);
    expect(second.reason).toBe(first.reason);
    expect(first.reason.name).toBe("AbortError");
    expect(first.reason.code).toBe(20);
  } finally {
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});
