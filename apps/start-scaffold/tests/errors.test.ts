import { isError as packageIsError, raise as packageRaise } from "@tinker/start/testing";
import { expect, test } from "vite-plus/test";

import { fail, isError, raise } from "~/components/errors";

test("copied and package errors agree while runtime parts move", () => {
  let old: unknown;
  try {
    packageRaise("BadSettings", { part: "auth", keys: ["AUTH_SECRET"] });
  } catch (error) {
    old = error;
  }

  expect(isError(old, "BadSettings")).toBe(true);
  expect(packageIsError(fail("Cancelled", {}), "Cancelled")).toBe(true);
  expect(() => raise("StartScopeMissing", {})).toThrow("StartScopeMissing");
});

test("kind checks refuse plain objects and a different error kind", () => {
  expect(isError({ kind: "Cancelled", payload: {} }, "Cancelled")).toBe(false);
  expect(isError(fail("Cancelled", {}), "StartScopeMissing")).toBe(false);
});
