import type { MainClosed, MainContext, MainStarted } from "@tinker/bun";

/** The host's inputs and what a command answers: `@tinker/bun`'s own, for every host here. */
export type { MainClosed, MainContext, MainStarted };

/** Type-only entry marker, with no startup, state, or hidden error policy. */
export const defineMain = <R extends MainStarted>(main: (ctx: MainContext) => R | Promise<R>) =>
  main;
