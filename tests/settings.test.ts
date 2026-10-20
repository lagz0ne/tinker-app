import { existsSync, readdirSync, readFileSync } from "node:fs";

import { createScope } from "@tinker/core";
import type { Tag } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { authSettings, authStartup } from "~/components/auth/index.server";
import { databaseMigrationTimeout } from "~/components/database/index.server";
import { databaseSetup, databaseUrl } from "~/components/database/index.server";
import { mailLeaseMs, mailSendTimeout } from "~/components/mail/index.server";
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

const authTags = [authSettings({ origin: "http://proof.test", secret: "s".repeat(32) })];

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

for (const [name, contract, rejected, accepted] of [
  ["migration wait", databaseMigrationTimeout, [0, -1, 1.5, 60001], [1, 5000, 60000]],
  ["mail lease", mailLeaseMs, [0, 119999, 1.5, 3600001], [120000, 180000, 3600000]],
  ["mail total send", mailSendTimeout, [0, -1, 1.5, 3001], [1, 100, 3000]],
] as const) {
  test(`${name}: typed bounds reject unsafe budgets and accept their edges`, () => {
    for (const value of rejected) expect(() => contract(value)).toThrow();
    for (const value of accepted) expect(() => contract(value)).not.toThrow();
  });
}

test("env examples name only tags that tinker/ or cmds/ declares", () => {
  const app = new URL("../", import.meta.url);
  const declared = new Set<string>();
  for (const folder of ["tinker", "cmds"]) {
    const files = readdirSync(new URL(folder, app), { recursive: true, encoding: "utf8" });
    for (const file of files.filter((name) => /\.tsx?$/.test(name))) {
      const source = readFileSync(new URL(`${folder}/${file}`, app), "utf8");
      for (const match of source.matchAll(/export const (\w+) = tag\b/g)) declared.add(match[1]);
    }
  }

  for (const path of [".env.example", "templates/env.example"]) {
    if (!existsSync(new URL(path, app))) continue;
    const named = readFileSync(new URL(path, app), "utf8")
      .split("\n")
      .flatMap((line) => line.match(/^# Required [^:]*: (.+)$/)?.[1].split(",") ?? [])
      .map((entry) => entry.trim().split(" ")[0]);
    expect(named.length, path).toBeGreaterThan(0);
    expect(
      named.filter((name) => !declared.has(name)),
      path,
    ).toEqual([]);
  }
});
