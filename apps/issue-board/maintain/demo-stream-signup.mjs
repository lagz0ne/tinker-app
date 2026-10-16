import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import pg from "pg";

const origin = process.env.BOARD_ORIGIN ?? "http://localhost:4327";
const session = "stream-signup-" + process.pid;
const email = session + "@example.test";
const db = new pg.Client({ connectionString: "postgres://issue_board@127.0.0.1:15433/postgres" });

function browser(...args) {
  const reply = JSON.parse(
    execFileSync(
      "agent-browser",
      ["--engine", "lightpanda", "--session", session, "--json", ...args],
      { encoding: "utf8", timeout: 35000 },
    ),
  );

  assert.equal(reply.success, true, reply.error);
  return reply.data;
}

await db.connect();

try {
  browser("open", origin);

  browser(
    "wait",
    "--fn",
    'Object.keys(document.querySelector("form") ?? {}).some(key=>key.startsWith("__reactProps$"))',
  );

  browser("fill", 'input[name="name"]', "Stream signup");

  browser("fill", 'input[name="email"]', email);

  browser("fill", 'input[name="password"]', "safe-password-42");

  browser("find", "role", "button", "click", "--name", "Make account", "--exact");

  browser("wait", "--text", "Open teams");

  const created = await db.query(
    'SELECT s.id, s.revision FROM sync_stream s JOIN "user" u ON u.id=s.id WHERE u.email=$1',
    [email],
  );

  assert.equal(
    created.rows.length,
    1,
    "sign-up must create the stream before the first teams page",
  );

  assert.equal(created.rows[0].revision, 0);

  browser("find", "role", "link", "click", "--name", "Open teams", "--exact");

  browser("wait", "--text", "No teams yet. Make your first team.");

  browser("reload");

  browser("wait", "--text", "No teams yet. Make your first team.");

  assert.deepEqual(browser("errors").errors, []);

  const mail = await (
    await fetch("http://localhost:18026/api/v1/search?query=" + encodeURIComponent("to:" + email))
  ).json();

  assert.equal(mail.messages.length, 1, "verification mail must stay in local Mailpit");

  console.log(
    "PASS Lightpanda: sign-up creates one stream; first teams page and reload work; no page errors; one local Mailpit message.",
  );
} finally {
  browser("close");
  await db.end();
}
