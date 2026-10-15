import { expect, test } from "vite-plus/test";

import { fail, isError, raise } from "~/components/errors";

test("managed errors from another owner agree by kind without sharing constructors", () => {
  const foreign = Object.assign(new Error("foreign failure"), { kind: "Cancelled", payload: {} });
  expect(isError(foreign, "Cancelled")).toBe(true);
  expect(fail("Cancelled", {}).kind).toBe("Cancelled");
  expect(() => raise("StartScopeMissing", {})).toThrow("StartScopeMissing");
});

test("kind checks refuse plain objects and a different error kind", () => {
  expect(isError({ kind: "Cancelled", payload: {} }, "Cancelled")).toBe(false);
  expect(isError(fail("Cancelled", {}), "StartScopeMissing")).toBe(false);
});
