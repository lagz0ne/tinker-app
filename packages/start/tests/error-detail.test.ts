import { expect, test } from "vite-plus/test";
import { errorDetail } from "../src/entry/error-detail.ts";

test("a production error page shows no error text; dev shows the message", () => {
  const error = new Error("boom: secret detail");
  expect(errorDetail(error, false)).toBeUndefined();
  expect(errorDetail(error, true)).toBe("boom: secret detail");
  expect(errorDetail("plain", true)).toBe("plain");
});
