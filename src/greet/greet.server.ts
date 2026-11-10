import { operation } from "@tinker/core";

import { greetApi } from "./contract";

/** The server's work for `greet.api.greet`: the rpc capsule checks its output against the contract. */
export const greetHere = operation({
  label: "greet.here",
  input: greetApi.greet.input,
  run: async (_deps, { input }) => ({ text: `Hello, ${input.name}.` }),
});

/** The server's side of `greet.api`, by address: `greet.api({ implement: greetOps })`. */
export const greetOps = { greet: greetHere } as const;
