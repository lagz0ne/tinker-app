import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const origin = process.env.BOARD_ORIGIN ?? "http://localhost:4327";
const runId = `${process.pid}-${Date.now()}`;
const a = `issue-board-a-${runId}`;
const b = `issue-board-b-${runId}`;
const emailA = `board-a-${runId}@example.test`;
const emailB = `board-b-${runId}@example.test`;

/** Drive only this trial's named Lightpanda sessions through the allowed CLI. */
function browser(session, ...args) {
  const reply = JSON.parse(
    execFileSync(
      process.env.BOARD_BROWSER ?? "agent-browser",
      ["--engine", "lightpanda", "--session", session, "--json", ...args],
      {
        encoding: "utf8",
        timeout: 35000,
      },
    ),
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
  browser(a, "find", "role", "link", "click", "--name", "Open ENG issues", "--exact");
  browser(a, "wait", 'input[name="title"]');
  browser(a, "fill", 'form:not([data-issue]) input[name="title"]', "Fix login");
  browser(a, "find", "role", "button", "click", "--name", "Create issue", "--exact");
  browser(a, "wait", "--text", "ENG-1 · Fix login");
  browser(a, "fill", 'form:not([data-issue]) input[name="title"]', "Add search");
  browser(a, "find", "role", "button", "click", "--name", "Create issue", "--exact");
  browser(a, "wait", "--text", "ENG-2 · Add search");

  browser(b, "find", "role", "link", "click", "--name", "Open ENG issues", "--exact");
  browser(b, "wait", "--text", "ENG-2 · Add search");
  browser(b, "find", "role", "button", "click", "--name", "Edit ENG-1", "--exact");
  browser(
    a,
    "eval",
    `const source = document.querySelector('[data-card="ENG-1"]'); window.boardTransfer = new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer:window.boardTransfer}));`,
  );
  browser(
    a,
    "eval",
    `document.querySelector('[data-state="in_progress"]').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:window.boardTransfer}));`,
  );
  browser(
    b,
    "wait",
    "--fn",
    `document.querySelector('[data-state="in_progress"] [data-card="ENG-1"]') !== null`,
  );
  browser(b, "fill", 'form[data-issue="ENG-1"] input[name="title"]', "Stale title");
  browser(b, "find", "role", "button", "click", "--name", "Save ENG-1", "--exact");
  browser(b, "wait", "--text", "This issue changed. Close this edit and open it again.");
  assert(
    browser(
      b,
      "eval",
      `document.querySelector('[data-card="ENG-1"]').textContent.includes("Fix login")`,
    ).result,
  );
  browser(b, "find", "role", "button", "click", "--name", "Close edit", "--exact");
  browser(a, "find", "role", "button", "click", "--name", "Edit ENG-1", "--exact");

  const member = browser(
    a,
    "eval",
    `[...document.querySelector('form[data-issue="ENG-1"] select[name="assigneeId"]').options].find(option => option.textContent === "User B").value`,
  ).result;
  browser(a, "select", 'form[data-issue="ENG-1"] select[name="state"]', "in_progress");
  browser(a, "select", 'form[data-issue="ENG-1"] select[name="priority"]', "1");
  browser(a, "select", 'form[data-issue="ENG-1"] select[name="assigneeId"]', member);
  browser(a, "find", "role", "button", "click", "--name", "Save ENG-1", "--exact");
  browser(
    a,
    "wait",
    "--fn",
    `document.querySelector('[data-testid="issue-summary-1"]').textContent.includes("In progress · Priority 1 · User B")`,
  );
  browser(a, "find", "role", "button", "click", "--name", "Edit ENG-2", "--exact");
  browser(a, "select", 'form[data-issue="ENG-2"] select[name="state"]', "done");
  browser(a, "select", 'form[data-issue="ENG-2"] select[name="priority"]', "3");
  browser(a, "find", "role", "button", "click", "--name", "Save ENG-2", "--exact");
  browser(
    a,
    "wait",
    "--fn",
    `document.querySelector('[data-testid="issue-summary-2"]').textContent.includes("Done · Priority 3 · Unassigned")`,
  );
  browser(a, "reload");
  browser(
    a,
    "wait",
    "--fn",
    `document.querySelector('[data-testid="issue-summary-1"]')?.textContent.includes("In progress · Priority 1 · User B")`,
  );
  browser(
    a,
    "wait",
    "--fn",
    `document.querySelector('[data-testid="issue-summary-2"]')?.textContent.includes("Done · Priority 3 · Unassigned")`,
  );
  execFileSync(
    "benchctl",
    ["exec", "--net", "--timeout", "120", "--", "node", "maintain/measure-live.mjs", a, b],
    { stdio: "inherit" },
  );
  if (process.env.BOARD_PREVIEW) {
    const main = browser(a, "eval", "document.querySelector('main').outerHTML").result;
    const css = readdirSync("dist/client/assets")
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(`dist/client/assets/${name}`, "utf8"))
      .join("\n");
    mkdirSync(process.env.BOARD_PREVIEW, { recursive: true });
    writeFileSync(
      `${process.env.BOARD_PREVIEW}/index.html`,
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue board · Slice 3</title><style>${css}</style><div class="p-5 bg-blue-50">Saved board from the two-user demo. This preview has no live controls.</div>${main}<footer class="p-5"><h2>Feedback</h2><p>Is the board easy to read on your phone? Reply in chat.</p></footer><script>document.querySelectorAll('input,textarea,select,button').forEach(node=>node.disabled=true);document.querySelectorAll('a').forEach(node=>node.removeAttribute('href'));</script></html>`,
    );
  }
  if (process.env.BOARD_STATE) browser(a, "state", "save", process.env.BOARD_STATE);

  assert.deepEqual(browser(a, "errors").errors, []);
  assert.deepEqual(browser(b, "errors").errors, []);
  console.log(
    "PASS slice 3 (agent-browser / Lightpanda): A sends HTML5 drag/drop for ENG-1 to In progress; B sees it without reload. B stale edit is rejected. A creates ENG-1 and ENG-2; ENG-1 is in_progress, priority 1, assigned to B; ENG-2 is done, priority 3, unassigned. Saved values survive reload. Slice 1 sign-up and team add also pass. No page errors.",
  );
} finally {
  browser(a, "close");
  browser(b, "close");
}

execFileSync(process.execPath, ["maintain/proof-issues.mjs"], { stdio: "inherit" });
