import { createScope } from "@tinker/core";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { greet } from "@/greet";
import { Greeting } from "@/greet";
import { greetOps } from "@/greet/index.server";

// In a real Chromium: a Tinker scope runs the rpc key here, React draws its answer.

test("the greeting draws what the greet key answers", async () => {
  const scope = await createScope({ capsules: [greet.api({ implement: greetOps })] }).ready;
  const { text } = await scope.run(greet.api.greet, { input: { name: "browser" } });

  const box = document.body.appendChild(document.createElement("div"));
  createRoot(box).render(<Greeting text={text} />);

  await expect.element(page.getByText("Hello, browser.")).toBeVisible();
  expect(navigator.userAgent).toContain("Chrome");
  await scope.close();
});
