import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const repo = resolve(app, "../..");
const { chromium } = createRequire(
  process.env.COMPOSE_BROWSER_CONTAINER === "1"
    ? join(app, "package.json")
    : join(repo, "packages/react/package.json"),
)("playwright");
const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:18025";
const origin = "http://127.0.0.1:44318";
const host = spawn(process.execPath, ["--env-file=.env", "scripts/serve.mjs"], {
  cwd: app,
  env: { ...process.env, HOST: "127.0.0.1", PORT: "44318", PUBLIC_ORIGIN: origin },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
host.stdout.on("data", (data) => (output += data));
host.stderr.on("data", (data) => (output += data));
const closed = new Promise((done, failed) => {
  host.once("error", failed);
  host.once("exit", done);
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const email = `refine-${crypto.randomUUID()}@example.com`;
try {
  const ready = AbortSignal.timeout(30000);
  for (;;) {
    try {
      const response = await fetch(origin, { signal: ready });
      assert.equal(response.status, 200, await response.text());
      break;
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED" || ready.aborted) throw error;
    }
  }
  const streaming = page.waitForResponse((response) => response.url().includes("/api/sync"));
  await page.goto(`${origin}/profile`, { waitUntil: "load", timeout: 30000 });
  assert.equal(page.url(), `${origin}/`);
  await streaming;
  await page.getByLabel("Name", { exact: true }).fill("Refine Owner");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("safe-password-42");
  await page.getByRole("button", { name: "Make account", exact: true }).click();
  await page.getByRole("link", { name: "Open private list" }).waitFor();
  await page.getByRole("link", { name: "Open private list" }).click();
  await page.getByLabel("New todo").fill("Saved through real Postgres");
  await page.getByRole("button", { name: "Add todo", exact: true }).click();
  await page.getByText("Saved through real Postgres", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Saved through real Postgres", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Refine Saved Name");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByText("Name saved and notification accepted.", { exact: true }).waitFor();
  const inbox = await fetch(`${mailpit}/api/v1/messages`).then((response) => response.json());
  const messages = inbox.messages.filter((message) =>
    message.To.some((to) => to.Address === email),
  );
  assert.ok(messages.some((message) => message.Subject === "Check your email"));
  assert.ok(messages.some((message) => message.Subject === "Your profile was updated"));
  const mailPage = await browser.newPage();
  await mailPage.goto(mailpit);
  await mailPage.getByText("Your profile was updated", { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  const proof = {
    signedOutRedirect: "profile redirected to public page before signup",
    signup: "passed through browser and real auth",
    todo: "saved and present after reload through real Postgres",
    profile: "saved with complete mail result",
    mailpit: messages.map((message) => ({
      id: message.ID,
      subject: message.Subject,
      to: message.To,
    })),
    mailpitBrowser: "message seen in Mailpit inbox",
    pageErrors: errors,
    phoneOverflow: false,
    services: "compose Postgres, Mailpit, VictoriaTraces, VictoriaLogs",
  };
  await writeFile("/tmp/start-refine-compose-proof.json", JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  await browser.close();
  host.kill("SIGTERM");
  const code = await closed;
  await writeFile("/tmp/start-refine-compose-host.log", output + `\nEXIT ${code}\n`);
  assert.equal(code, 0, output);
}
