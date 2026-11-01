import { operation } from "@tinker/core";

import { greet } from "@/api/greet";

/** The server's work for the greet contract. `satisfies` keeps its input and reply equal. */
export const greetHere = operation({
  label: "greet.here",
  input: greet.input,
  run: async (_deps, { input }) => ({ text: `Hello, ${input.name}.` }),
}) satisfies typeof greet;
