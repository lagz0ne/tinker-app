#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generatorBlocked, staleTree } from "../lib/checks/generated.mjs";
import { doctor } from "../lib/doctor.mjs";
import { prepare, prepareExitCode, writeRouteTree } from "../lib/prepare.mjs";
import { serve } from "../lib/serve.mjs";
import { upgrade } from "../lib/upgrade.mjs";

const [command, ...rest] = process.argv.slice(2);
const root = process.cwd();
const flag = (name) => rest[rest.indexOf(name) + 1];
const commands = {
  prepare: async () => {
    const files = prepare(root);
    const blocked = generatorBlocked(root);
    if (blocked.length === 0) files.push(await writeRouteTree(root));
    const problems = blocked.length > 0 ? blocked : staleTree(root);
    console.log(
      problems.length > 0
        ? problems.join("\n")
        : `tinker prepare: wrote .tinker/${files.join(", .tinker/")}`,
    );
    return prepareExitCode(problems, process.env.npm_lifecycle_event);
  },
  doctor: () => doctor(root, rest.includes("--fix")),
  upgrade: () =>
    upgrade(root, rest[0], {
      from: rest.includes("--from") ? flag("--from") : undefined,
      force: rest.includes("--force"),
    }),
  serve: () => serve(root),
};
if (!existsSync(join(root, "package.json")) || !(command in commands)) {
  console.log("usage: tinker prepare | doctor [--fix] | upgrade <version> [--from <dir>] | serve");
  process.exit(2);
}
process.exitCode = await commands[command]();
