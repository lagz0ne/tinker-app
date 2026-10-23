import { defineMain } from "~/base/main";

import { handOff } from "@/old-tool";

/**
 * tinker-loop as a CLI-only Start app (docs/decisions/loop-on-tinker.md). Until ticket 8 ports
 * the operations, each command goes to the old tool in lib/, with this context's folder, output,
 * and stop: the strangler fig. lib/ picks the exit code.
 */
export default defineMain(async ({ args, cwd, stdout, stderr, signal, exit }) => {
  exit(await handOff({ args: [...args], cwd, stdout, stderr, signal }));
  return { closed: Promise.resolve() };
});
