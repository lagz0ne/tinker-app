import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// benchctl runs this driver on the host. The shared sockets drive the same two
// Lightpanda tabs and the real dev server; no extra proxy or test transport.
const [a, b, control = "0"] = process.argv.slice(2);
const controlWaitMs = Number(control);

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

const samples = [];

for (let index = 0; index < 6; index++) {
  const state = index % 2 === 0 ? "backlog" : "in_progress";
  browser(a, "wait", "--fn", `!document.querySelector('[data-card="ENG-1"] select').disabled`);
  browser(
    b,
    "wait",
    "--fn",
    `document.querySelector('[data-state="${state === "backlog" ? "in_progress" : "backlog"}"] [data-card="ENG-1"]') !== null`,
  );

  browser(
    b,
    "eval",
    `window.boardSeenAt = null; new MutationObserver((_, observer) => { if (document.querySelector('[data-state="${state}"] [data-card="ENG-1"]')) { window.boardSeenAt = Date.now(); observer.disconnect(); } }).observe(document.querySelector('main'), {childList:true,subtree:true});`,
  );
  browser(
    a,
    "eval",
    `(() => { window.boardDragAt = Date.now(); const source = document.querySelector('[data-card="ENG-1"]'); const transfer = new DataTransfer(); source.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:transfer})); window.boardTransfer = transfer; })()`,
  );
  browser(
    a,
    "eval",
    `window.boardDropAt = Date.now(); document.querySelector('[data-state="${state}"]').dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:window.boardTransfer}));`,
  );
  await delay(controlWaitMs);
  browser(b, "wait", "--fn", "window.boardSeenAt !== null");

  const started = browser(a, "eval", "window.boardDropAt").result;
  const seen = browser(b, "eval", "window.boardSeenAt").result;
  assert(seen >= started);
  if (index > 0) samples.push(seen - started);
}

const ordered = [...samples].sort((a, b) => a - b);
const middle = Math.floor(ordered.length / 2);
const median = ordered[middle];
const mad = samples.map((value) => Math.abs(value - median)).sort((a, b) => a - b)[middle];

console.log(
  JSON.stringify({
    proof: "HTML5 drop to other tab DOM, real SSE, no reload",
    unit: "ms",
    warmup: 1,
    controlWaitMs,
    samples,
    min: ordered[0],
    median,
    mad,
    max: ordered[ordered.length - 1],
    note: "Queued driver; live browser/server include host load; clocks are on the same host.",
  }),
);
