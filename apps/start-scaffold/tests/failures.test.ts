import { createScope, operation } from "@tinker/core";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { FailureAlert } from "@/frontend/failures";

/** A form action that fails the way the app's actions do: Core's raise with an app payload. */
const failingAction = operation({
  label: "test.failingAction",
  input: z.object({ kind: z.string(), payload: z.record(z.string(), z.string()) }),
  run: (_deps, { input, raise }) => raise(input.kind, input.payload),
});

const alertFor = (kind: string, payload: Record<string, string>) => {
  const result = createScope().settle(failingAction, { input: { kind, payload } });
  if (result.status !== "failed") return expect.unreachable("the action must fail");
  return renderToStaticMarkup(FailureAlert({ error: result.error }));
};

test("an auth or write refusal shows its own message", () => {
  expect(alertFor("AuthFailed", { message: "Wrong password." })).toBe(
    '<p role="alert">Wrong password.</p>',
  );
  expect(alertFor("WriteRejected", { message: "Name taken." })).toBe(
    '<p role="alert">Name taken.</p>',
  );
});

test("a refused input shows its reason", () => {
  expect(alertFor("BadInput", { reason: "Use a name with 1 to 80 letters." })).toBe(
    '<p role="alert">Use a name with 1 to 80 letters.</p>',
  );
});

test("any other failure shows the retry hint, and no failure shows nothing", () => {
  expect(alertFor("SignInRequired", {})).toBe('<p role="alert">That did not work. Try again.</p>');
  expect(alertFor("AuthFailed", { reason: "wrong field" })).toBe(
    '<p role="alert">That did not work. Try again.</p>',
  );
  expect(renderToStaticMarkup(FailureAlert({ error: undefined, className: "text-sm" }))).toBe(
    '<p role="alert" class="text-sm"></p>',
  );
});
