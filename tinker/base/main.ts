import type { MainClosed, MainContext } from "@tinker/bun";

/** The host's inputs and the root close results: `@tinker/bun`'s own, for every host here. */
export type { MainClosed, MainContext };

/** Type-only entry marker, with no startup, state, or hidden error policy. */
export const defineMain = <R extends { closed: MainClosed }>(
  main: (ctx: MainContext) => Promise<R>,
) => main;
