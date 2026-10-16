import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep the existing real two-tab drag checks, without clocks or a timing observer.
const [a, b] = process.argv.slice(2);

const browserPath = fileURLToPath(
  new URL(
    "../../../../../.local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64",
    import.meta.url,
  ),
);

const socketDir = fileURLToPath(new URL("../../../../../.agent-browser", import.meta.url));

function browser(session, ...args) {
  const result = JSON.parse(
    execFileSync(browserPath, ["--session", session, "--json", ...args], {
      encoding: "utf8",
      timeout: 35000,
      env: { ...process.env, AGENT_BROWSER_SOCKET_DIR: socketDir },
    }),
  );
  assert(result.success, result.error);
  return result.data;
}

const marker = `sync-proof-${crypto.randomUUID()}`;
browser(b, "eval", `window.boardSyncProof = ${JSON.stringify(marker)}`);

for (let index = 0; index < 12; index++) {
  const state = index % 2 === 0 ? "backlog" : "in_progress";
  browser(a, "wait", "--fn", `!document.querySelector('[data-card="ENG-1"] select').disabled`);
  browser(
    b,
    "wait",
    "--fn",
    `document.querySelector('[data-state="${state === "backlog" ? "in_progress" : "backlog"}"] [data-card="ENG-1"]') !== null`,
  );

  browser(
    a,
    "eval",
    `(() => { const source = document.querySelector('[data-card="ENG-1"]'); const transfer = new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:transfer})); window.boardTransfer = transfer; })()`,
  );
  browser(
    a,
    "eval",
    `document.querySelector('[data-state="${state}"]').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:window.boardTransfer}));`,
  );
  browser(
    b,
    "wait",
    "--fn",
    `document.querySelector('[data-state="${state}"] [data-card="ENG-1"]') !== null`,
  );
  assert.equal(browser(b, "eval", "window.boardSyncProof").result, marker);
}

console.log(
  "PASS 12 HTML5 drops: the other tab receives each move through real SSE with no reload.",
);
