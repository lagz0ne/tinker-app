import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { resource } from "@tinker/core";
import { z } from "zod";

import { appDir } from "@/tags";

import { git } from "./git";

/** One rule of rules.md: its ID, its group heading, and its lines. */
const rule = z.object({ id: z.string(), group: z.string().nullable(), lines: z.array(z.string()) });

const ruleStart = /^- `([A-Z][0-9]+)` \S/;
const groupHeading = /^### [A-Z]: .+$/;

/**
 * The rules of the app's own @tinker/start, so each app reads the rules of its own Start
 * version. `read` throws a plain message when there is no Start, no rules file, or a line the
 * parser cannot read.
 */
export const startRules = resource({
  label: "loop.startRules",
  depends: { appDir, git },
  factory: ({ appDir: app, git: answers }) => {
    /** The parse of one rules.md text: its rules, each ID's line, and the open group and rule. */
    type Parse = {
      rules: z.infer<typeof rule>[];
      seen: Map<string, number>;
      group: string | null;
      open: z.infer<typeof rule> | null;
    };

    const parser = {
      /**
       * The app's own @tinker/start folder: Node's node_modules lookup, from the app folder up to
       * the top of its git repo. NODE_PATH and Node's global folders belong to whatever runs the
       * tool, not to the app, so they are not used. Outside git, the lookup goes up to the root.
       */
      folder: () => {
        const stop = answers.top();
        for (let at = realpathSync(app); ; at = dirname(at)) {
          const start = join(at, "node_modules", "@tinker", "start");
          if (existsSync(join(start, "package.json"))) return start;
          if (at === stop || at === dirname(at)) break;
        }
        throw new Error(`cannot find @tinker/start from ${app}; install it to read its rules`);
      },
      /** Stop the parse at a line it cannot read. */
      fail: (number: number, problem: string): never => {
        throw new Error(`line ${number}: ${problem}`);
      },
      /** Why rule `id` cannot start here, or null when it can. */
      ruleProblem: (state: Parse, id: string) => {
        const { group, seen } = state;
        if (!group) return `rule ${id} is not under a "### <letter>: <title>" group heading`;
        if (id[0] !== group[0]) {
          return `rule ${id} is in group ${group[0]}; its ID must start ${group[0]}`;
        }
        return seen.has(id) ? `rule ${id} is listed twice; first at line ${seen.get(id)}` : null;
      },
      /** Open a rule at its "- `ID` text" line. */
      startRule: (state: Parse, line: string, number: number) => {
        const id = ruleStart.exec(line)?.[1];
        if (!id) {
          return parser.fail(number, 'a rule line reads "- `ID` text", with an ID such as B1');
        }
        const problem = parser.ruleProblem(state, id);
        if (problem) parser.fail(number, problem);

        state.seen.set(id, number);
        state.open = { id, group: state.group, lines: [line] };
        state.rules.push(state.open);
      },
      /** The group a heading starts: null for a `#` or `##` heading, which ends the group. */
      heading: (line: string, number: number) => {
        if (/^#{1,2} /.test(line)) return null;
        if (!groupHeading.test(line)) {
          parser.fail(number, 'a group heading reads "### <letter>: <title>"');
        }
        return line.slice(4);
      },
      /** Inside a group, a line that is not a rule must be blank. */
      groupLine: (group: string, line: string, number: number) => {
        if (line.startsWith("#")) {
          parser.fail(number, 'a group heading reads "### <letter>: <title>"');
        }
        if (line.trim()) {
          parser.fail(
            number,
            `in group ${group[0]}, a line is blank, a rule "- \`ID\` text", a two-space line right after a rule line, or a heading`,
          );
        }
      },
      /** Read one line into the parse. */
      line: (state: Parse, line: string, number: number) => {
        if (line.startsWith("- `")) return parser.startRule(state, line, number);
        if (state.open && line.startsWith("  ")) return void state.open.lines.push(line);

        state.open = null;
        if (/^#{1,6} /.test(line)) state.group = parser.heading(line, number);
        else if (state.group) parser.groupLine(state.group, line, number);
      },
      /**
       * The rules in a rules.md text, in file order. A `### <letter>: <title>` heading starts a
       * group, and a `#` or `##` heading ends it. A rule is a list item "- `ID` text" inside a
       * group whose letter starts the ID; its next lines are indented by two spaces. Inside a
       * group, every other line is blank or a heading. Throws, naming the line, on anything else.
       */
      parse: (text: string) => {
        const state: Parse = { rules: [], seen: new Map(), group: null, open: null };
        text.split(/\r?\n/).forEach((line, index) => parser.line(state, line, index + 1));
        if (state.rules.length === 0) throw new Error("no rules found");
        return state.rules;
      },
      /** The app's Start version, its rules.md path, and its rules. */
      read: () => {
        const start = parser.folder();
        let version: unknown;
        try {
          ({ version } = JSON.parse(readFileSync(join(start, "package.json"), "utf8")));
        } catch (error) {
          const { code, message } = error as NodeJS.ErrnoException;
          throw new Error(`cannot read @tinker/start from ${app}: ${code ?? message}`);
        }

        const path = join(start, "docs", "rules.md");
        if (!existsSync(path)) {
          throw new Error(
            `@tinker/start ${String(version)} has no docs/rules.md; it is older than the rules file`,
          );
        }
        try {
          return {
            version: String(version),
            path,
            rules: parser.parse(readFileSync(path, "utf8")),
          };
        } catch (error) {
          throw new Error(`${path}: ${(error as Error).message}`);
        }
      },
    };

    return parser;
  },
});
