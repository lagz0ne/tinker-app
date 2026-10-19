import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const ruleStart = /^- `([A-Z][0-9]+)` \S/;
const groupHeading = /^### [A-Z]: .+$/;

/**
 * The rules in a `docs/rules.md` text, in file order. A `### <letter>: <title>` heading starts
 * a group, and a `## ` heading ends it. A rule is a list item "- `ID` text" inside a group whose
 * letter starts the ID; its next lines are indented by two spaces. Any other line ends the rule.
 * Throws, naming the line, on a bad rule line or heading, a rule outside a group, a wrong
 * letter, or a repeated ID. Throws when there is no rule at all.
 * @param {string} text - From readRules or a test; why: the markdown to read.
 */
export function parseRules(text) {
  const read = { rules: [], group: null, open: null, seen: new Map() };
  text.split(/\r?\n/).forEach((line, index) => readLine(read, line, index + 1));

  if (read.rules.length === 0) throw new Error("no rules found");
  return read.rules;
}

/**
 * @param {{ rules: object[], group: string | null, open: object | null,
 *   seen: Map<string, number> }} read - From parseRules; why: the rules so far and the open
 *   group and rule this line may belong to.
 * @param {string} line - From the text; why: the line to read.
 * @param {number} number - From parseRules; why: names the line in an error.
 */
function readLine(read, line, number) {
  if (line.startsWith("- `")) {
    read.open = startRule(read, line, number);
    read.rules.push(read.open);
    return;
  }
  if (read.open && line.startsWith("  ")) {
    read.open.lines.push(line);
    return;
  }

  read.open = null;
  if (line.startsWith("## ")) read.group = null;
  if (!line.startsWith("### ")) return;
  if (!groupHeading.test(line)) {
    throw new Error(`line ${number}: a group heading reads "### <letter>: <title>"`);
  }
  read.group = line.slice(4);
}

/**
 * @param {{ group: string | null, seen: Map<string, number> }} read - From readLine; why: the
 *   group the rule belongs to and the IDs seen so far.
 * @param {string} line - From the text; why: the rule's first line.
 * @param {number} number - From parseRules; why: names the line in an error.
 */
function startRule(read, line, number) {
  const id = ruleStart.exec(line)?.[1];
  const problem = !id
    ? 'a rule line reads "- `ID` text", with an ID such as B1'
    : ruleProblem(read, id);
  if (problem) throw new Error(`line ${number}: ${problem}`);

  read.seen.set(id, number);
  return { id, group: read.group, lines: [line] };
}

/**
 * @param {{ group: string | null, seen: Map<string, number> }} read - From startRule.
 * @param {string} id - From the rule line; why: the ID to place.
 */
function ruleProblem({ group, seen }, id) {
  if (!group) return `rule ${id} is not under a "### <letter>: <title>" group heading`;
  if (id[0] !== group[0]) {
    return `rule ${id} is in group ${group[0]}; its ID must start ${group[0]}`;
  }
  return seen.has(id) ? `rule ${id} is listed twice; first at line ${seen.get(id)}` : null;
}

/**
 * A rule's words on one line, without its list mark and ID.
 * @param {{ lines: string[] }} rule - From parseRules; why: the lines to join.
 */
export function ruleText(rule) {
  return rule.lines.map((line) => line.replace(/^- `[A-Z][0-9]+` /, "").trim()).join(" ");
}

/**
 * The rules of the @tinker/start that the app itself resolves, so each app reads the rules
 * of its own Start version. Throws a plain message when there is no Start or no rules file.
 * @param {string} app - From --app; why: Node resolves @tinker/start from this folder.
 */
export function readRules(app) {
  const manifest = startManifest(app);
  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  const path = join(dirname(manifest), "docs", "rules.md");
  if (!existsSync(path)) {
    throw new Error(
      `@tinker/start ${version} has no docs/rules.md; it is older than the rules file`,
    );
  }

  try {
    return { version, path, rules: parseRules(readFileSync(path, "utf8")) };
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

/** @param {string} app - From readRules; why: Node resolves @tinker/start from this folder. */
function startManifest(app) {
  try {
    return createRequire(join(app, "package.json")).resolve("@tinker/start/package.json");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Error(`cannot find @tinker/start from ${app}; install it to read its rules`);
    }
    throw new Error(`cannot resolve @tinker/start from ${app}: ${error.code ?? error.message}`);
  }
}
