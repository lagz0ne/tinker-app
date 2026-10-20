import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import {
  databaseConnectTimeout,
  databaseLockTimeout,
  databaseMigrationTimeout,
  databaseStatementTimeout,
  databaseStop,
} from "~/components/database/index.server";
import { mailLeaseMs, mailSendTimeout, mailWorkerStop } from "~/components/mail/index.server";

test("unbound budgets keep their safe public defaults without opening IO", async () => {
  const root = createScope();
  try {
    expect(root.resolve(databaseConnectTimeout)).toBe(5000);

    expect(root.resolve(databaseLockTimeout)).toBe(500);
    expect(root.resolve(databaseStatementTimeout)).toBe(1000);
    expect(root.resolve(databaseMigrationTimeout)).toBe(5000);
    expect(root.resolve(mailLeaseMs)).toBe(180000);
    expect(root.resolve(mailSendTimeout)).toBe(3000);
    expect(root.resolve(databaseStop)).toBeUndefined();
    expect(root.resolve(mailWorkerStop)).toBeUndefined();
  } finally {
    await root.close();
  }
});

for (const [name, setting, maximum] of [
  ["checkout", databaseConnectTimeout, Infinity],
  ["lock", databaseLockTimeout, 1000],
  ["statement", databaseStatementTimeout, 2000],
] as const) {
  test(`${name} budget takes only positive whole milliseconds within its bound`, () => {
    for (const value of [0, -1, 1.5, NaN, Infinity]) expect(() => setting(value)).toThrow();
    for (const value of [1, 500]) expect(() => setting(value)).not.toThrow();
    if (Number.isFinite(maximum)) {
      expect(() => setting(maximum)).not.toThrow();
      expect(() => setting(maximum + 1)).toThrow();
    }
  });
}
