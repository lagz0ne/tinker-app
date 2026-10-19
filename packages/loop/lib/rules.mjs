import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const ruleStart = /^- `([A-Z][0-9]+)` /;

/**
 * The rules in a `docs/rules.md` text, in file order. A `### <letter>: <title>` heading names
 * the group. A rule is a list item that starts "- `ID` "; its next lines are indented by two
 * spaces. Any other line ends the rule. A repeated ID throws.
 * @param {string} text - From readRules or a test; why: the markdown to read.
 */
export function parseRules(text) {
  const rules = [];
  let group = "";
  let open = null;

  for (const line of text.split("\n")) {
    const start = ruleStart.exec(line);
    if (start) rules.push((open = { id: start[1], group, lines: [line] }));
    else if (open && line.startsWith("  ")) open.lines.push(line);
    else {
      open = null;
      if (line.startsWith("### ")) group = line.slice(4);
    }
  }

  const seen = new Set();
  for (const { id } of rules) {
    if (seen.has(id)) throw new Error(`rule ${id} is listed twice`);
    seen.add(id);
  }
  return rules;
}

/**
 * A rule's words on one line, without its list mark and ID.
 * @param {{ lines: string[] }} rule - From parseRules; why: the lines to join.
 */
export function ruleText(rule) {
  return rule.lines.map((line) => line.replace(ruleStart, "").trim()).join(" ");
}

/**
 * The rules of the @tinker/start that the app itself resolves, so each app reads the rules
 * of its own Start version. Throws a plain message when there is no Start or no rules file.
 * @param {string} app - From --app; why: Node resolves @tinker/start from this folder.
 */
export function readRules(app) {
  let manifest;
  try {
    manifest = createRequire(join(app, "package.json")).resolve("@tinker/start/package.json");
  } catch {
    throw new Error(`cannot find @tinker/start from ${app}; install it to read its rules`);
  }

  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  const path = join(dirname(manifest), "docs", "rules.md");
  if (!existsSync(path)) {
    throw new Error(
      `@tinker/start ${version} has no docs/rules.md; it is older than the rules file`,
    );
  }
  return { version, path, rules: parseRules(readFileSync(path, "utf8")) };
}
