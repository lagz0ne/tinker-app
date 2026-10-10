import { expect, test } from "vite-plus/test";
import { accountNotice, accountOfNotice } from "../src/parts/sync/notice";

test("a notice payload names its account, and a table wake names none", () => {
  expect(accountNotice("ada")).toBe("account:ada");
  expect(accountOfNotice(accountNotice("ada"))).toBe("ada");
  expect(accountOfNotice("sync_event")).toBeNull();
  expect(accountOfNotice("session")).toBeNull();
});

test("an account ID keeps its own colons, and a name that only starts alike names none", () => {
  expect(accountOfNotice(accountNotice("tenant:ada"))).toBe("tenant:ada");
  expect(accountOfNotice("accounts:ada")).toBeNull();
  expect(accountOfNotice("")).toBeNull();
});
