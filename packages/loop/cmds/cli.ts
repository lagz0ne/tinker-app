import { defineMain } from "~/base/main";

/**
 * tinker-loop as a CLI-only Start app (docs/decisions/loop-on-tinker.md). The commands come in
 * ticket 8. Until then bin/tinker-loop.mjs runs lib/, and any input here exits 64.
 */
export default defineMain(async ({ args, stderr, exit }) => {
  const said = ["tinker-loop", ...args.slice(0, 1)].join(" ");
  stderr.write(
    `${said}: the app has no commands yet; bin/tinker-loop.mjs runs lib/ until ticket 8\n`,
  );
  exit(64);
  return { closed: Promise.resolve() };
});
