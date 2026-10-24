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
    /**
     * The app's own @tinker/start folder: Node's node_modules lookup, from the app folder up to
     * the top of its git repo. NODE_PATH and Node's global folders belong to whatever runs the
     * tool, not to the app, so they are not used. Outside git, the lookup goes up to the root.
     */
    const folder = () => {
      const stop = answers.top();
      for (let at = realpathSync(app); ; at = dirname(at)) {
        const start = join(at, "node_modules", "@tinker", "start");
        if (existsSync(join(start, "package.json"))) return start;
        if (at === stop || at === dirname(at)) break;
      }
      throw new Error(`cannot find @tinker/start from ${app}; install it to read its rules`);
    };

    /**
     * The rules in a rules.md text, in file order. A `### <letter>: <title>` heading starts a
     * group, and a `#` or `##` heading ends it. A rule is a list item "- `ID` text" inside a
     * group whose letter starts the ID; its next lines are indented by two spaces. Inside a
     * group, every other line is blank or a heading. Throws, naming the line, on anything else.
     */
    const parse = (text: string) => {
      const rules: z.infer<typeof rule>[] = [];
      const seen = new Map<string, number>();
      let group: string | null = null;
      let open: (typeof rules)[number] | null = null;

      const fail = (number: number, problem: string) => {
        throw new Error(`line ${number}: ${problem}`);
      };
      const ruleProblem = (id: z.infer<typeof rule>["id"]) => {
        if (!group) return `rule ${id} is not under a "### <letter>: <title>" group heading`;
        if (id[0] !== group[0]) {
          return `rule ${id} is in group ${group[0]}; its ID must start ${group[0]}`;
        }
        return seen.has(id) ? `rule ${id} is listed twice; first at line ${seen.get(id)}` : null;
      };
      const startRule = (line: string, number: number) => {
        const id = ruleStart.exec(line)?.[1];
        if (!id) return fail(number, 'a rule line reads "- `ID` text", with an ID such as B1');
        const problem = ruleProblem(id);
        if (problem) fail(number, problem);

        seen.set(id, number);
        open = { id, group, lines: [line] };
        rules.push(open);
      };
      const heading = (line: string, number: number) => {
        if (/^#{1,2} /.test(line)) return null;
        if (!groupHeading.test(line)) fail(number, 'a group heading reads "### <letter>: <title>"');
        return line.slice(4);
      };
      const groupLine = (line: string, number: number) => {
        if (line.startsWith("#")) fail(number, 'a group heading reads "### <letter>: <title>"');
        if (line.trim()) {
          fail(
            number,
            `in group ${group?.[0]}, a line is blank, a rule "- \`ID\` text", a two-space line right after a rule line, or a heading`,
          );
        }
      };
      const readLine = (line: string, number: number) => {
        if (line.startsWith("- `")) return startRule(line, number);
        if (open && line.startsWith("  ")) return void open.lines.push(line);

        open = null;
        if (/^#{1,6} /.test(line)) group = heading(line, number);
        else if (group) groupLine(line, number);
      };

      text.split(/\r?\n/).forEach((line, index) => readLine(line, index + 1));
      if (rules.length === 0) throw new Error("no rules found");
      return rules;
    };

    return {
      /** The app's Start version, its rules.md path, and its rules. */
      read: () => {
        const start = folder();
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
          return { version: String(version), path, rules: parse(readFileSync(path, "utf8")) };
        } catch (error) {
          throw new Error(`${path}: ${(error as Error).message}`);
        }
      },
    };
  },
});
