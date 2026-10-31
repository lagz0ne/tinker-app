import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { deliverMailBatch, outboxWake, mailWorkerStop } from "~/components/mail/index.server";

import { queueDailyDigests } from "@/backend/digest.server";
import { runMailWorker } from "@/backend/outbox.server";

test("real Core worker recovers a plain delivery error before its clean stop", async () => {
  const stop = new AbortController();
  const messages: string[] = [];
  let attempts = 0;
  const root = createScope({
    observe: { log: (entry) => messages.push(entry.message) },
    presets: [
      preset(queueDailyDigests, async () => ({ queued: 0 })),
      preset(deliverMailBatch, async () => {
        if (++attempts === 1) throw new Error("temporary database failure");
        return { claimed: 0, dead: 0, sent: 0, failed: 0 };
      }),
      preset(outboxWake, async () => ({
        listen: async () => {},
        retry: async () => {},
        wait: async () => {
          stop.abort(new Error("SIGTERM"));
        },
      })),
    ],
  });

  try {
    await expect(
      root.run(runMailWorker, { tags: [mailWorkerStop(stop.signal)] }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(messages.filter((message) => message === "outbox.unavailable")).toHaveLength(1);
    expect((await root.close({ graceful: true })).status).toBe("success");
  } finally {
    stop.abort();
    await root.close();
  }
});
