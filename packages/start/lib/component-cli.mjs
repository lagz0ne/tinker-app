import { Refusal, addComponent, checkComponents, updateComponent } from "./component-commands.mjs";
import { registryBase } from "./registry.mjs";

/** The one usage line, shared with the bin so add/update/check and the old commands agree. */
export const usage =
  "usage: tinker prepare | doctor [--fix] | serve | add <name> | update <name> [--force] | check [--registry <path|url>]";

/** The commands this file runs, and the name each one needs. */
const commands = {
  add: { name: true, force: false, run: (root, { name, base }) => addComponent(root, name, base) },
  update: {
    name: true,
    force: true,
    run: (root, { name, base, force }) => updateComponent(root, name, base, { force }),
  },
  check: { name: false, force: false, run: (root, { base }) => checkComponents(root, base) },
};

/** @param {string} command - From the bin; why: which flags its command accepts. */
function flagsOf(command) {
  return commands[command].force ? ["--force", "--registry"] : ["--registry"];
}

/**
 * Read one component command's words: at most one name, and only the flags it knows.
 * @param {string} command - From the bin; why: which words are legal.
 * @param {string[]} args - From the bin; why: the words after the command.
 */
function parseArgs(command, args) {
  const known = flagsOf(command);
  const parsed = { name: undefined, force: false, registry: undefined };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const kind = applyFlag(arg, parsed, known, args[index + 1]);
    if (kind === "unknown") return null;
    if (kind === "flag") {
      index += arg === "--registry" ? 1 : 0;
      continue;
    }
    if (!takesName(command, parsed, arg)) return null;

    parsed.name = arg;
  }

  return commands[command].name && parsed.name === undefined ? null : parsed;
}

/**
 * Apply one flag word, if the command takes it.
 * @param {string} arg - From parseArgs; why: the word to read.
 * @param {{ force: boolean, registry?: string }} parsed - From parseArgs; why: what a flag changes.
 * @param {string[]} known - From flagsOf; why: the flags this command takes.
 * @param {string|undefined} value - From parseArgs; why: the word after `--registry`.
 */
function applyFlag(arg, parsed, known, value) {
  if (!known.includes(arg)) return "none";
  if (arg === "--force") {
    parsed.force = true;
    return "flag";
  }
  if (value === undefined) return "unknown";

  parsed.registry = value;
  return "flag";
}

/**
 * Whether this word can be the command's name.
 * @param {string} command - From parseArgs; why: check takes no name.
 * @param {{ name?: string }} parsed - From parseArgs; why: the name already read.
 * @param {string} arg - From parseArgs; why: the word to read.
 */
function takesName(command, parsed, arg) {
  return !arg.startsWith("-") && parsed.name === undefined && commands[command].name;
}

/**
 * Run add, update, or check, and return the lines to print with the exit code.
 * @param {string} command - From bin/tinker.mjs; why: which command ran.
 * @param {string} root - From bin/tinker.mjs; why: the app folder.
 * @param {string[]} args - From bin/tinker.mjs; why: the words after the command.
 */
export async function componentCommand(command, root, args) {
  const parsed = parseArgs(command, args);
  if (parsed === null) return { lines: [usage], code: 64 };

  const base = registryBase(root, parsed.registry);
  try {
    return await commands[command].run(root, { ...parsed, base });
  } catch (error) {
    if (error instanceof Refusal) return { lines: error.lines, code: 1 };
    return { lines: [`tinker ${command}: ${error.message}`], code: 1 };
  }
}
