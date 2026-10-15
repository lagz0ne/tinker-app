import assert from "node:assert/strict";

import { chromium } from "playwright";

const origin = process.env.BOARD_ORIGIN ?? "http://localhost:4327";
const run = Date.now();
const emailA = `board-a-${run}@example.test`;
const emailB = `board-b-${run}@example.test`;
const browser = await chromium.launch({ headless: true });
const a = await browser.newContext({ viewport: { width: 390, height: 844 } });
const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
const pageA = await a.newPage();
const pageB = await b.newPage();
const failures = [];
a.setDefaultTimeout(15000);
b.setDefaultTimeout(15000);

for (const page of [pageA, pageB]) {
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
}

try {
  await pageA.goto(origin);
  await pageA.waitForFunction(() =>
    Object.keys(document.querySelector("form") ?? {}).some((key) =>
      key.startsWith("__reactProps$"),
    ),
  );
  await pageA.getByLabel("Name", { exact: true }).fill("User A");
  await pageA.getByLabel("Email", { exact: true }).fill(emailA);
  await pageA.getByLabel("Password", { exact: true }).fill("board-proof-password-42");
  await pageA.getByRole("button", { name: "Make account", exact: true }).click();
  await pageA.getByRole("link", { name: "Open teams" }).click();
  await pageA.getByLabel("Team key", { exact: true }).fill("ENG");
  await pageA.getByLabel("Team name", { exact: true }).fill("Engineering");
  await pageA.getByRole("button", { name: "Make team", exact: true }).click();
  await pageA.getByRole("heading", { name: "ENG · Engineering", exact: true }).waitFor();
  await pageA.getByRole("button", { name: "Make team", exact: true }).isEnabled();

  await pageB.goto(origin);
  await pageB.waitForFunction(() =>
    Object.keys(document.querySelector("form") ?? {}).some((key) =>
      key.startsWith("__reactProps$"),
    ),
  );
  await pageB.getByLabel("Name", { exact: true }).fill("User B");
  await pageB.getByLabel("Email", { exact: true }).fill(emailB);
  await pageB.getByLabel("Password", { exact: true }).fill("board-proof-password-42");
  await pageB.getByRole("button", { name: "Make account", exact: true }).click();
  await pageB.getByRole("link", { name: "Open teams" }).click();
  await pageB.getByText("No teams yet. Make your first team.", { exact: true }).waitFor();

  await pageA.getByLabel("Member email", { exact: true }).fill(emailB);
  await pageA.getByRole("button", { name: "Add member", exact: true }).click();
  await pageB.getByRole("heading", { name: "ENG · Engineering", exact: true }).waitFor();
  await pageB.getByText("Your role: member", { exact: true }).waitFor();
  assert.equal(await pageB.getByRole("button", { name: "Add member", exact: true }).count(), 0);
  assert.equal(
    await pageB.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await pageB.reload();
  await pageB.getByRole("heading", { name: "ENG · Engineering", exact: true }).waitFor();
  await pageB.getByText("Your role: member", { exact: true }).waitFor();
  await pageB.screenshot({
    path: process.env.BOARD_SCREENSHOT ?? "/home/paseo/plans/issue-board-demo.png",
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  console.log(
    "PASS: A signs up, creates ENG; B signs up; A adds B by email; B sees ENG live and after reload. Mobile fits. No page errors.",
  );
} catch (error) {
  console.error("Demo failed:", error.message, "Page errors:", failures);
  console.error(
    "A:",
    await pageA
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  );
  console.error(
    "B:",
    await pageB
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  );
  throw error;
} finally {
  await browser.close();
}
