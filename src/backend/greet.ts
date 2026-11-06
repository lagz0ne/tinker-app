import { operation } from "@tinker/core";

import { api } from "@/api";

/** The server's work for `api.greet`: the rpc capsule checks its output against the contract. */
export const greetHere = operation({
  label: "greet.here",
  input: api.greet.input,
  run: async (_deps, { input }) => ({ text: `Hello, ${input.name}.` }),
});
