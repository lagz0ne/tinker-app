import { exits } from "@tinkered/cli/test";
import { createScope, operation } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { telemetry } from "~/components/telemetry";

const tick = operation({ label: "console.tick", run: () => 1 });

/** A console that counts what each method got. */
const counted = () => {
  const got = { info: 0, warn: 0, error: 0 };
  const console = {
    info: () => void (got.info += 1),
    warn: () => void (got.warn += 1),
    error: () => void (got.error += 1),
  };
  return { got, console };
};

/** Runs `tick` 1000 times in a tab root; each run is one span. */
const tab = async (spans?: boolean) => {
  const { got, console } = counted();
  const app = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      telemetry.browser({ service: "console-test", console, ...(spans ? { spans } : {}) }),
    ],
  }).ready;
  for (let i = 0; i < 1000; i += 1) app.run(tick);
  await app.close();
  return got.info;
};

test("1000 spans in a tab write nothing to the console by default (#66)", async () => {
  const lines = await tab();

  expect(lines).toBe(0);
});

test("`spans: true` writes each span to the tab's console", async () => {
  const lines = await tab(true);

  expect(lines).toBeGreaterThanOrEqual(1000);
});
