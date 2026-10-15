import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { ErrorDetails } from "~/base/panics";

test("the error page hides server details in production and shows them in dev", () => {
  const error = new Error("boom: secret detail");

  expect(renderToStaticMarkup(ErrorDetails({ error, dev: false }))).not.toContain("secret detail");
  expect(renderToStaticMarkup(ErrorDetails({ error, dev: true }))).toContain("boom: secret detail");
  expect(renderToStaticMarkup(ErrorDetails({ error: "plain", dev: true }))).toContain("plain");
});
