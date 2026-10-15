import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const origin = process.env.BOARD_ORIGIN ?? "http://localhost:4327";
const runId = `${process.pid}-${Date.now()}`;
const a = `issue-board-a-${runId}`;
const b = `issue-board-b-${runId}`;
const emailA = `board-a-${runId}@example.test`;
const emailB = `board-b-${runId}@example.test`;

/** Drive only this trial's named Lightpanda sessions through the allowed CLI. */
function browser(session, ...args) {
  const reply = JSON.parse(
    execFileSync("agent-browser", ["--session", session, "--json", ...args], {
      encoding: "utf8",
      timeout: 35000,
    }),
  );
  assert.equal(reply.success, true, reply.error);

  return reply.data;
}

try {
  browser(a, "open", origin);
  assert.equal(browser(a, "eval", 'document.querySelector("form").method').result, "post");
  browser(
    a,
    "wait",
    "--fn",
    'Object.keys(document.querySelector("form") ?? {}).some(key => key.startsWith("__reactProps$"))',
  );
  browser(a, "fill", 'input[name="name"]', "User A");
  browser(a, "fill", 'input[name="email"]', emailA);
  browser(a, "fill", 'input[name="password"]', "board-proof-password-42");
  browser(a, "find", "role", "button", "click", "--name", "Make account", "--exact");
  browser(a, "wait", "--text", "Open teams");
  browser(a, "find", "role", "link", "click", "--name", "Open teams", "--exact");
  browser(a, "wait", 'input[name="key"]');
  browser(a, "fill", 'input[name="key"]', "ENG");
  browser(a, "fill", 'input[name="name"]', "Engineering");
  browser(a, "find", "role", "button", "click", "--name", "Make team", "--exact");
  browser(a, "wait", "--text", "ENG · Engineering");

  browser(b, "open", origin);
  browser(
    b,
    "wait",
    "--fn",
    'Object.keys(document.querySelector("form") ?? {}).some(key => key.startsWith("__reactProps$"))',
  );
  browser(b, "fill", 'input[name="name"]', "User B");
  browser(b, "fill", 'input[name="email"]', emailB);
  browser(b, "fill", 'input[name="password"]', "board-proof-password-42");
  browser(b, "find", "role", "button", "click", "--name", "Make account", "--exact");
  browser(b, "wait", "--text", "Open teams");
  browser(b, "find", "role", "link", "click", "--name", "Open teams", "--exact");
  browser(b, "wait", "--text", "No teams yet. Make your first team.");

  browser(a, "fill", 'input[name="email"]', emailB);
  browser(a, "find", "role", "button", "click", "--name", "Add member", "--exact");
  browser(b, "wait", "--text", "ENG · Engineering");
  browser(b, "wait", "--text", "Your role: member");
  assert.equal(
    browser(
      b,
      "eval",
      '[...document.querySelectorAll("button")].some(button => button.textContent === "Add member")',
    ).result,
    false,
  );
  browser(b, "reload");
  browser(b, "wait", "--text", "ENG · Engineering");
  browser(b, "wait", "--text", "Your role: member");
  assert.deepEqual(browser(a, "errors").errors, []);
  assert.deepEqual(browser(b, "errors").errors, []);
  console.log(
    "PASS (agent-browser / Lightpanda): A signs up and creates ENG; B signs up; A adds B by email; B sees ENG live and after reload. Form uses POST. No page errors.",
  );
} finally {
  browser(a, "close");
  browser(b, "close");
}
