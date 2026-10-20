import { operation } from "@tinker/core";

import { deliverMailBatch, outboxWake, mailWorkerStop } from "~/components/mail/index.server";

import { tickMailDigest } from "./digest.server";

/** Native worker integration: one child per claimed batch, with soft-stop commit. */
export const runMailPass = operation({
  label: "outbox.pass",
  depends: {
    deliver: deliverMailBatch.controller,
    digest: tickMailDigest.controller,
    stopping: mailWorkerStop,
  },
  run: async ({ deliver, digest, stopping }, { signal: contextSignal, log }) => {
    const signal = stopping ?? contextSignal;
    await digest.run();
    if (signal.aborted) return;
    let result;
    do {
      const delivered = await deliver.settle({ signal: contextSignal });
      if (delivered.status === "failed") throw delivered.error;
      if (delivered.status === "cancelled") return;
      result = delivered.value;
      log("outbox.batch", result);
    } while (result.claimed === 20 && !signal.aborted);
  },
});

export const runMailWorker = operation({
  label: "outbox.worker",
  depends: { pass: runMailPass.controller, wake: outboxWake, stopping: mailWorkerStop },
  run: async ({ pass, wake, stopping }, { signal: contextSignal, log }) => {
    const signal = stopping ?? contextSignal;
    while (!signal.aborted) {
      try {
        await wake.listen();
        const passed = await pass.settle();
        if (passed.status === "failed") throw passed.error;
      } catch (error) {
        if (signal.aborted) return;
        log.error("outbox.unavailable", { error: String(error) });
        await wake.retry();
        continue;
      }
      if (!signal.aborted) await wake.wait();
    }
  },
});
