import type { MainClosed, MainContext, MainStarted } from "@tinkered/bun";

/** The host's inputs and what a command answers: `@tinkered/bun`'s own, for every host here. */
export type { MainClosed, MainContext, MainStarted };

/** Type-only entry marker, with no startup, state, or hidden error policy. */
export const defineMain = <R extends MainStarted>(main: (ctx: MainContext) => R | Promise<R>) =>
  main;
