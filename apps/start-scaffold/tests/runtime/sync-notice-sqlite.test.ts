import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { accountNotice } from "~/components/sync-sqlite/notice";
import { notifications } from "~/components/sync-sqlite/notifications.server";

import { handWoken } from "./fixtures/sync-sqlite";

/** Test notice decoding through the real listener owner, including non-notice table wakes. */
async function checkPayloads(rows: [string, string | null][]) {
  const { db, emit } = handWoken();
  const root = createScope({ presets: [db] });
  const feed = await root.resolve(notifications);

  for (const [payload, account] of rows) {
    const subscribers = await Promise.all(
      ["ada", "tenant:ada", "grace"].map((id) => feed.subscribe(undefined, id)),
    );
    const before = feed.revision();
    emit(payload);

    expect(feed.revision(), payload).toBe(before + Number(account === null));
    expect(
      subscribers.map((subscriber) => subscriber.stale),
      payload,
    ).toEqual(["ada", "tenant:ada", "grace"].map((id) => id === account));
    subscribers.forEach((subscriber) => feed.close(subscriber));
  }

  expect((await root.close({ graceful: true })).status).toBe("success");
}

test("a notice payload names its account, and a table wake names none", async () => {
  expect(accountNotice("ada")).toBe("account:ada");
  await checkPayloads([
    [accountNotice("ada"), "ada"],
    ["sync_event", null],
    ["session", null],
  ]);
});

test("an account ID keeps its own colons, and a name that only starts alike names none", async () => {
  await checkPayloads([
    [accountNotice("tenant:ada"), "tenant:ada"],
    ["accounts:ada", null],
    ["", null],
  ]);
});
