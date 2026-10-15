import { createScope } from "@tinker/core";
import type { Tag } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import {
  authSettings,
  authStartup,
  sendAuthMail,
  sessionDeleted,
} from "~/components/auth/index.server";
import { databaseSetup, databaseUrl } from "~/components/database/index.server";
import { mailStartup, smtpUrl, mailFrom } from "~/components/mail/index.server";
import { backendStop, startRequests } from "~/components/requests";
import { syncSide, syncStartup } from "~/components/sync";
import { tabStop } from "~/components/sync";
import { bootstrapSlot, readAccountSlot } from "~/components/sync/index.server";
import {
  telemetryExport,
  telemetryService,
  telemetrySide,
  tracesUrl,
  logsUrl,
} from "~/components/telemetry/index.server";

import { bootstrap, readAccount } from "@/demo/index.server";

import { clientBindings } from "./presets";

const authTags = [
  authSettings({ origin: "http://proof.test", secret: "s".repeat(32) }),
  sendAuthMail(() => {}),
  sessionDeleted(async () => {}),
];

const mailTags = [smtpUrl(new URL("smtp://proof.test:25")), mailFrom("proof@example.com")];

const telemetryTags = [
  telemetrySide("server"),
  telemetryService("proof"),
  tracesUrl(new URL("http://proof.test/traces")),
  logsUrl(new URL("http://proof.test/logs")),
];

for (const [name, startup, tags] of [
  ["requests", startRequests, [backendStop(new AbortController().signal)]],
  [
    "sync server",
    syncStartup,
    [syncSide("server"), bootstrapSlot(bootstrap), readAccountSlot(readAccount)],
  ],
  ["sync tab", syncStartup, [...clientBindings, tabStop(new AbortController().signal)]],
  ["auth", authStartup, authTags],
  ["database", databaseSetup, [databaseUrl(new URL("postgres://proof"))]],
  ["mail", mailStartup, mailTags],
  ["telemetry", telemetryExport, telemetryTags],
] as const) {
  test(`${name}: each missing required config tag rejects ready with its name`, async () => {
    for (const missing of tags) {
      const remaining = tags.filter((binding) => binding !== missing) as Tag.Bindings;
      const root = createScope({ extensions: [startup], tags: remaining });
      await expect(root.ready).rejects.toMatchObject({
        kind: "MissingTag",
        payload: { label: missing.tag.label },
      });
      expect((await root.close({ graceful: true })).status).toBe("failed");
    }
  });
}

test("tag contracts reject wrong typed values without an env converter", () => {
  expect(() => databaseUrl("postgres://proof" as unknown as URL)).toThrow(
    expect.objectContaining({ kind: "DataValidationFailed" }),
  );
  expect(() => mailFrom("not an address")).toThrow(
    expect.objectContaining({ kind: "DataValidationFailed" }),
  );
});
