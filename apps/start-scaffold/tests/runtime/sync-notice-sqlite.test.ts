import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { accountNotice } from "~/components/sync-sqlite/notice";
import { notifications } from "~/components/sync-sqlite/notifications.server";

import { handWoken } from "./fixtures/sync-sqlite";

/** One row the listener hears: an account notice, or a raw payload another table's wake sends. */
type Wake = { notice: string } | { raw: string };

/** Test notice decoding through the real listener owner, including non-notice table wakes. */
async function checkPayloads(rows: [Wake, string | null][]) {
  const { db, emit } = handWoken();
  const root = createScope({ presets: [db] });
  const feed = await root.resolve(notifications);

  for (const [wake, account] of rows) {
    const subscribers = await Promise.all(
      ["ada", "tenant:ada", "grace"].map((id) => feed.subscribe(undefined, id)),
    );
    const before = feed.revision();
    const payload = "notice" in wake ? root.run(accountNotice, { input: wake.notice }) : wake.raw;
    if ("notice" in wake) expect(payload).toBe(`account:${wake.notice}`);
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
  await checkPayloads([
    [{ notice: "ada" }, "ada"],
    [{ raw: "sync_event" }, null],
    [{ raw: "session" }, null],
  ]);
});

test("an account ID keeps its own colons, and a name that only starts alike names none", async () => {
  await checkPayloads([
    [{ notice: "tenant:ada" }, "tenant:ada"],
    [{ raw: "accounts:ada" }, null],
    [{ raw: "" }, null],
  ]);
});
