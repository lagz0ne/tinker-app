import { expect, test } from "vite-plus/test";

import { fail, loop, loopJson, repo, setFindings } from "./fixture.mjs";

const finding = (id, status, severity, extra = {}) => ({
  id,
  rule: "G1",
  severity,
  file: id,
  line: null,
  summary: `${id} broke`,
  trigger: "t",
  fix: `fix ${id}`,
  source: "check",
  round: 1,
  status,
  ...extra,
});

test("findings lists open first, important first, with reasons and fix commits", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  setFindings(app, [
    finding("done", "fixed", "important", { sha: "abcdef0123456789" }),
    finding("why", "answered", "nit", { reason: "kept on purpose" }),
    finding("ask", "open", "question"),
    finding("must", "open", "important"),
  ]);

  const { code, stdout } = await loop(app, "findings");

  expect(code).toBe(0);
  expect(stdout).toBe(
    [
      "open important G1 must: must broke [must] (round 1)",
      "  fix: fix must",
      "open question G1 ask: ask broke [ask] (round 1)",
      "  fix: fix ask",
      "answered nit G1 why: why broke [why] (round 1)",
      "  reason: kept on purpose",
      "fixed important G1 done: done broke [done] (round 1)",
      "  fixed at abcdef012345",
      "",
    ].join("\n"),
  );
});

test("findings --open shows only open findings; an empty app has none", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  const empty = await loop(app, "findings");
  await loop(app, "check");
  setFindings(app, [finding("must", "open", "important"), finding("done", "fixed", "nit")]);

  const { stdout } = await loop(app, "findings", "--open");

  expect(empty.stdout).toBe("no findings\n");
  expect(stdout).toContain("must");
  expect(stdout).not.toContain("done");
});

test("a broken findings line names the file and line and exits 78", async () => {
  const app = repo({ "loop.json": loopJson({ red: fail }) });
  await loop(app, "check");
  setFindings(app, [finding("must", "open", "important")]);
  const { appendFileSync } = await import("node:fs");
  appendFileSync(`${app}/.loop/findings.jsonl`, "{not json\n");

  const run = await loop(app, "findings");

  expect(run.code).toBe(78);
  expect(run.stderr).toContain("findings.jsonl:2 is not one JSON object");
});
