import { createScope } from "@tinker/core";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";
import { Greeting } from "@/greeting";

// In a real Chromium: a Tinker scope runs the rpc key here, React draws its answer.

test("the greeting draws what the greet key answers", async () => {
  const scope = await createScope({ capsules: [api({ implement: { greet: greetHere } })] }).ready;
  const { text } = await scope.run(api.greet, { input: { name: "browser" } });

  const box = document.body.appendChild(document.createElement("div"));
  createRoot(box).render(<Greeting text={text} />);

  await expect.element(page.getByText("Hello, browser.")).toBeVisible();
  expect(navigator.userAgent).toContain("Chrome");
  await scope.close();
});
