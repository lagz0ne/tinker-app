import { createScope, operation } from "@tinker/core";
import type { Tag } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { syncSide, syncStartup, tabStop } from "~/components/sync-sqlite";
import { bootstrapSlot, readAccountSlot } from "~/components/sync-sqlite/index.server";

import { clientBindings } from "./presets-sqlite";

/** Stand-in server reads: startup only checks that each slot is bound. */
const bootstrap = operation({
  label: "proof.sqliteBootstrap",
  run: () => ({ public: { stream: "public" as const, revision: 0 }, private: null }),
});

const readAccount = operation({ label: "proof.sqliteReadAccount", run: () => null });

for (const [name, tags] of [
  [
    "sync-sqlite server",
    [syncSide("server"), bootstrapSlot(bootstrap), readAccountSlot(readAccount)],
  ],
  ["sync-sqlite tab", [...clientBindings, tabStop(new AbortController().signal)]],
] as const) {
  test(`${name}: each missing required slot rejects ready with its name`, async () => {
    for (const missing of tags) {
      const remaining = tags.filter((binding) => binding !== missing) as Tag.Bindings;

      const root = createScope({ extensions: [syncStartup], tags: remaining });

      await expect(root.ready).rejects.toMatchObject({
        kind: "MissingTag",
        payload: { label: missing.tag.label },
      });
      expect((await root.close({ graceful: true })).status).toBe("failed");
    }
  });
}
