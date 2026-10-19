import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const ruleStart = /^- `([A-Z][0-9]+)` \S/;
const groupHeading = /^### [A-Z]: .+$/;

/**
 * The rules in a `docs/rules.md` text, in file order. A `### <letter>: <title>` heading starts
 * a group, and a `#` or `##` heading ends it. A rule is a list item "- `ID` text" inside a group
 * whose letter starts the ID; its next lines are indented by two spaces. Inside a group, every
 * other line is blank or a heading. Throws, naming the line, on any other line in a group, a
 * bad rule line or heading, a rule outside a group, a wrong letter, or a repeated ID. Throws
 * when there is no rule at all.
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
  if (line.startsWith("#")) read.group = headingGroup(line, number);
  else if (read.group && line.trim()) {
    throw new Error(
      `line ${number}: in group ${read.group[0]}, a line is blank, a rule "- \`ID\` text", a two-space line right after a rule line, or a heading`,
    );
  }
}

/**
 * The group a heading starts: a `### <letter>: <title>` heading names it, and a `#` or `##`
 * heading ends the one before. Any other heading throws.
 * @param {string} line - From readLine; why: the heading.
 * @param {number} number - From parseRules; why: names the line in an error.
 */
function headingGroup(line, number) {
  if (/^#{1,2} /.test(line)) return null;
  if (!groupHeading.test(line)) {
    throw new Error(`line ${number}: a group heading reads "### <letter>: <title>"`);
  }
  return line.slice(4);
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
 * The rules of the app's own @tinker/start, so each app reads the rules of its own Start
 * version. Throws a plain message when there is no Start or no rules file.
 * @param {string} app - From --app; why: the lookup for @tinker/start starts in this folder.
 */
export function readRules(app) {
  const start = startFolder(app);
  let version;
  try {
    ({ version } = JSON.parse(readFileSync(join(start, "package.json"), "utf8")));
  } catch (error) {
    throw new Error(`cannot read @tinker/start from ${app}: ${error.code ?? error.message}`);
  }

  const path = join(start, "docs", "rules.md");
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

/**
 * The app's own @tinker/start folder: Node's node_modules lookup, from the app folder up to
 * the top folder of the app's git repo. NODE_PATH and Node's global folders are not used:
 * they belong to whatever runs the tool, not to the app. pnpm's bin shims, for one, set
 * NODE_PATH to the workspace's own packages. Outside git, the lookup goes up to the root.
 * @param {string} app - From readRules; why: the folder the lookup starts in.
 */
function startFolder(app) {
  const from = realpathSync(app);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: from, encoding: "utf8" });
  const stop = top.status === 0 ? top.stdout.trim() : null;

  for (let folder = from; ; folder = dirname(folder)) {
    const start = join(folder, "node_modules", "@tinker", "start");
    if (existsSync(join(start, "package.json"))) return start;
    if (folder === stop || folder === dirname(folder)) break;
  }
  throw new Error(`cannot find @tinker/start from ${app}; install it to read its rules`);
}
