/**
 * The old tool in lib/. cmds/cli.ts hands each command to it until ticket 8 ports the operations
 * into the graph; then this file goes (docs/decisions/loop-on-tinker.md, the strangler fig).
 */
// oxlint-disable-next-line import/no-relative-parent-imports -- The old tool serves until ticket 8.
export { main as handOff } from "../lib/main.mjs";
