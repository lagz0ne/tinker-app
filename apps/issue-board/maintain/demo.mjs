import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import pg from "pg";

const origin = process.env.BOARD_ORIGIN ?? "http://localhost:4327";
const runId = `${process.pid}-${Date.now()}`;
const a = `issue-board-a-${runId}`;
const b = `issue-board-b-${runId}`;
const outsider = `issue-board-outsider-${runId}`;
const emailOutsider = `board-outsider-${runId}@example.test`;
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

const worker = spawn(process.execPath, ["maintain/worker.mjs"], {
  env: { ...process.env, DIGEST_HOUR_UTC: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});

let workerOutput = "";

worker.stdout.on("data", (chunk) => {
  workerOutput += chunk.toString();
});

const workerExit = new Promise((resolve) =>
  worker.once("exit", (code, signal) => resolve({ code, signal })),
);

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

  browser(outsider, "open", origin);
  browser(
    outsider,
    "wait",
    "--fn",
    'Object.keys(document.querySelector("form") ?? {}).some(key => key.startsWith("__reactProps$"))',
  );
  browser(outsider, "fill", 'input[name="name"]', "Non-member");
  browser(outsider, "fill", 'input[name="email"]', emailOutsider);
  browser(outsider, "fill", 'input[name="password"]', "board-proof-password-42");
  browser(outsider, "find", "role", "button", "click", "--name", "Make account", "--exact");
  browser(outsider, "wait", "--text", "Open teams");
  browser(outsider, "find", "role", "link", "click", "--name", "Open teams", "--exact");
  browser(outsider, "wait", "--text", "No teams yet. Make your first team.");

  browser(a, "find", "role", "link", "click", "--name", "Open ENG issues", "--exact");
  browser(a, "wait", 'input[name="title"]');
  browser(a, "fill", 'form:not([data-issue]) input[name="title"]', "Fix login");
  browser(a, "find", "role", "button", "click", "--name", "Create issue", "--exact");
  browser(a, "wait", "--text", "ENG-1 · Fix login");
  browser(a, "fill", 'form:not([data-issue]) input[name="title"]', "Add search");
  browser(a, "find", "role", "button", "click", "--name", "Create issue", "--exact");
  browser(a, "wait", "--text", "ENG-2 · Add search");
  browser(
    a,
    "fill",
    '[data-card="ENG-1"] textarea[name="comment"]',
    "Existing discussion before B joins",
  );
  browser(a, "find", "role", "button", "click", "--name", "Add comment to ENG-1", "--exact");
  browser(a, "wait", "--text", "Existing discussion before B joins");
  browser(a, "find", "role", "link", "click", "--name", "All teams", "--exact");
  browser(a, "wait", 'input[name="email"]');
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

  browser(a, "find", "role", "link", "click", "--name", "Open ENG issues", "--exact");

  browser(b, "find", "role", "link", "click", "--name", "Open ENG issues", "--exact");
  browser(b, "wait", "--text", "ENG-2 · Add search");
  browser(b, "wait", "--text", "Existing discussion before B joins");
  browser(b, "fill", '[data-card="ENG-1"] textarea[name="comment"]', "Unsent local draft");
  browser(a, "fill", '[data-card="ENG-1"] textarea[name="comment"]', "A live comment for B");
  browser(a, "find", "role", "button", "click", "--name", "Add comment to ENG-1", "--exact");
  browser(b, "wait", "--text", "A live comment for B");
  assert.equal(
    browser(
      b,
      "eval",
      `document.querySelector('[data-card="ENG-1"] textarea[name="comment"]').value`,
    ).result,
    "Unsent local draft",
  );
  browser(b, "fill", '[data-card="ENG-1"] textarea[name="comment"]', "");
  browser(
    a,
    "wait",
    "--fn",
    `document.querySelector('[data-card="ENG-1"] textarea[name="comment"]').value === ""`,
  );
  const observer = new pg.Client({
    connectionString:
      process.env.BOARD_DATABASE_URL ?? "postgres://issue_board@127.0.0.1:15433/postgres",
  });
  await observer.connect();
  try {
    const visible = await observer.query(
      `SELECT u.email, count(*)::int AS count FROM sync_event e JOIN "user" u ON e.stream = u.id WHERE u.email = ANY($1::text[]) AND e.payload->'change'->>'kind' = 'comment.add' GROUP BY u.email`,
      [[emailA, emailB, emailOutsider]],
    );
    assert.equal(visible.rows.find((row) => row.email === emailOutsider)?.count ?? 0, 0);
    assert.equal(visible.rows.find((row) => row.email === emailB)?.count, 2);
    assert.equal(visible.rows.find((row) => row.email === emailA)?.count, 2);
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM sync_event WHERE stream = 'public' AND payload->'change'->>'kind' = 'comment.add'",
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await observer.end();
  }

  console.log(
    "PASS slice 4 comments: B receives the existing discussion on join, then A's new ENG-1 comment live with no reload; B's draft survives; actor form clears after save; actual non-member stream contains zero comment.add events.",
  );
  const delivered = new pg.Client({
    connectionString: "postgres://issue_board@127.0.0.1:15433/postgres",
  });
  await delivered.connect();
  try {
    const deadline = AbortSignal.timeout(40_000);
    let saved;
    do {
      deadline.throwIfAborted();
      saved = (
        await delivered.query(
          "SELECT * FROM mail_outbox WHERE \"to\" = $1 AND subject = 'New comment on ENG-1' AND text LIKE '%A live comment for B%'",
          [emailB],
        )
      ).rows;
      if (saved.length !== 1 || saved[0].sent_at === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } while (saved.length !== 1 || saved[0].sent_at === null);

    assert.equal(saved[0].attempts, 1);
    const inbox = await (
      await fetch(
        `http://127.0.0.1:18026/api/v1/search?query=${encodeURIComponent(`to:${emailB} subject:New comment on ENG-1`)}&limit=100`,
      )
    ).json();
    assert(inbox.messages.some((message) => message.Subject === "New comment on ENG-1"));
    assert.equal(
      (
        await delivered.query(
          "SELECT count(*)::int AS count FROM mail_outbox WHERE \"to\"=$1 AND dedupe_key NOT LIKE 'digest:%'",
          [emailOutsider],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await delivered.query(
          "SELECT count(*)::int AS count FROM mail_outbox WHERE \"to\"=$1 AND dedupe_key NOT LIKE 'digest:%'",
          [emailA],
        )
      ).rows[0].count,
      0,
    );
    console.log(
      "PASS slice 5 mail: A's saved comment alerts B through the outbox and local Mailpit; one delivery attempt; no non-member alert.",
    );
  } finally {
    await delivered.end();
  }
  const digestDb = new pg.Client({
    connectionString: "postgres://issue_board@127.0.0.1:15433/postgres",
  });
  await digestDb.connect();
  try {
    const day = new Date().toISOString().slice(0, 10);
    const deadline = AbortSignal.timeout(40_000);
    let receipt;
    do {
      deadline.throwIfAborted();
      receipt = (
        await digestDb.query('SELECT * FROM mail_outbox WHERE "to"=$1 AND dedupe_key LIKE $2', [
          emailB,
          `digest:%:${day}`,
        ])
      ).rows;
      if (receipt.length !== 1 || receipt[0].sent_at === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } while (receipt.length !== 1 || receipt[0].sent_at === null);

    const before = receipt[0].id;
    // Another board write already woke the scheduler; the unique receipt must remain one row.
    assert.equal(receipt[0].attempts, 1);
    const inbox = await (
      await fetch(
        `http://127.0.0.1:18026/api/v1/search?query=${encodeURIComponent(`to:${emailB} subject:Daily issue digest ${day}`)}&limit=100`,
      )
    ).json();
    assert.equal(inbox.messages.length, 1);

    const message = await (
      await fetch(`http://127.0.0.1:18026/api/v1/message/${inbox.messages[0].ID}`)
    ).json();
    assert(message.Text.includes("ENG-1"));
    assert.equal(
      (
        await digestDb.query(
          'SELECT count(*)::int AS count FROM mail_outbox WHERE "to"=$1 AND dedupe_key LIKE $2',
          [emailOutsider, `digest:%:${day}`],
        )
      ).rows[0].count,
      0,
    );
    console.log(
      `PASS slice 6 digest: B receives one UTC-day digest in local Mailpit, including ENG-1; durable receipt ${before}; outsider gets none.`,
    );
  } finally {
    await digestDb.end();
  }
  browser(b, "fill", '[data-card="ENG-1"] textarea[name="comment"]', "Selected comment text");
  const textDrag = browser(
    b,
    "eval",
    `const field = document.querySelector('[data-card="ENG-1"] textarea'); field.select(); window.textTransfer = new DataTransfer(); window.textTransfer.setData('text/plain', field.value); window.beforeTextDrag = Number(document.querySelector('[data-card="ENG-1"]').dataset.version); field.dispatchEvent(new DragEvent('dragstart', {bubbles:true,cancelable:true,dataTransfer:window.textTransfer})); window.textTransfer.getData('text/plain');`,
  ).result;
  assert.equal(textDrag, "Selected comment text");
  browser(
    b,
    "eval",
    `document.querySelector('[data-state="done"]').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:window.textTransfer}));`,
  );
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
  assert(
    browser(
      b,
      "eval",
      `Number(document.querySelector('[data-card="ENG-1"]').dataset.version) === window.beforeTextDrag + 1`,
    ).result,
  );
  console.log(
    "PASS selected comment text drag keeps text data and does not move the issue; the next real card move is the only version increment.",
  );
  browser(b, "fill", 'form[data-issue="ENG-1"] input[name="title"]', "Stale title");
  browser(b, "find", "role", "button", "click", "--name", "Save ENG-1", "--exact");
  browser(b, "wait", "--text", "Someone changed this issue first. Check the board and try again.");
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
  execFileSync(
    "benchctl",
    ["exec", "--net", "--timeout", "120", "--", "node", "maintain/measure-live.mjs", a, b, "200"],
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
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue board · Slice 4</title><style>${css}</style><div class="p-5 bg-blue-50">Saved board from the two-user demo. This preview has no live controls.</div>${main}<footer class="p-5"><h2>Feedback</h2><p>Is the board easy to read on your phone? Reply in chat.</p></footer><script>document.querySelectorAll('input,textarea,select,button').forEach(node=>node.disabled=true);document.querySelectorAll('a').forEach(node=>node.removeAttribute('href'));</script></html>`,
    );
  }
  if (process.env.BOARD_STATE) browser(a, "state", "save", process.env.BOARD_STATE);

  assert.deepEqual(browser(a, "errors").errors, []);
  assert.deepEqual(browser(b, "errors").errors, []);
  assert.deepEqual(browser(outsider, "errors").errors, []);
  console.log(
    "PASS slice 3 (agent-browser / Lightpanda): A sends HTML5 drag/drop for ENG-1 to In progress; B sees it without reload. B stale edit is rejected. A creates ENG-1 and ENG-2; ENG-1 is in_progress, priority 1, assigned to B; ENG-2 is done, priority 3, unassigned. Saved values survive reload. Slice 1 sign-up and team add also pass. No page errors.",
  );
} finally {
  browser(a, "close");
  browser(b, "close");
  browser(outsider, "close");

  worker.kill("SIGTERM");
  const stopped = await workerExit;
  assert.equal(stopped.code, 0, JSON.stringify(stopped));
  assert(workerOutput.includes("outbox worker stopped\n"));
  console.log(
    "PASS clean worker SIGTERM: stopped line printed; exit 0; claims released or committed.",
  );
}

execFileSync(process.execPath, ["maintain/proof-issues.mjs"], { stdio: "inherit" });

execFileSync(process.execPath, ["maintain/proof-lock-order.mjs"], { stdio: "inherit" });

execFileSync(process.execPath, ["maintain/proof-comments.mjs"], { stdio: "inherit" });

execFileSync(process.execPath, ["maintain/proof-outbox.mjs"], { stdio: "inherit" });

execFileSync(process.execPath, ["maintain/proof-worker-host.mjs"], { stdio: "inherit" });

execFileSync(process.execPath, ["maintain/proof-digest.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, ["maintain/proof-smtp-auth.mjs"], { stdio: "inherit" });
