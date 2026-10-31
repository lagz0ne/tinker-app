import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite-plus";

// The cmd for this proof: the only place that reads env. It never prints the key or the env.
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!oauthToken && !apiKey) {
  console.log("agent-talk live proof: not run (set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)");
} else {
  const credentials = oauthToken ? { oauthToken } : { apiKey };
  const model = process.env.AGENT_LIVE_MODEL || "claude-haiku-5-5";
  const configDir = await mkdtemp(join(tmpdir(), "agent-talk-live-"));

  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, watch: null },
    appType: "custom",
    resolve: {
      alias: [{ find: /^~\//, replacement: fileURLToPath(new URL("../tinker/", import.meta.url)) }],
    },
  });

  try {
    const component = await vite.ssrLoadModule("/tinker/components/agent-talk/index.server.ts");
    const { createScope } = await import("@tinker/core");
    const options = { model, tools: [], maxTurns: 1 };

    const open = () =>
      createScope({
        tags: [component.agentCredentials(credentials), component.agentConfigDir(configDir)],
      });

    const first = open();

    try {
      const talk = await first.resolve(component.agentTalk);
      let text = "";

      const result = await talk.run("live", {
        prompt: "Reply with the one word: ok.",
        options,
        onEvent: (event) => {
          if (event.type === "text") text += event.delta;
        },
      }).result;

      assert.equal(result.status, "done", `turn ended ${result.status}: ${result.message ?? ""}`);
      assert.match(text, /ok/i, "the streamed text holds ok");
      console.log(`PASS: a live turn on ${model} settled done and streamed its reply.`);
    } finally {
      await first.close();
    }

    const second = open();
    const talk = await second.resolve(component.agentTalk);
    const closed = Promise.withResolvers();
    let asked = false;
    let started = 0;

    const result = await talk.run("live", {
      prompt: "Count slowly from 1 to 300, one number per line, with a short word after each.",
      options,
      onEvent: (event) => {
        if (event.type !== "text" || asked) return;

        asked = true;
        started = performance.now();
        closed.resolve(second.close());
      },
    }).result;

    assert.ok(asked, "the turn streamed text before it ended");
    await closed.promise;

    const ms = performance.now() - started;

    assert.equal(result.status, "closed");
    assert.ok(ms < 15_000, `close took ${Math.round(ms)} ms`);
    console.log(
      `PASS: closing the scope mid-stream ended the turn closed in ${Math.round(ms)} ms.`,
    );
  } finally {
    await vite.close();
    await rm(configDir, { recursive: true, force: true });
  }
}
