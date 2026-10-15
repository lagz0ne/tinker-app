import { operation } from "@tinker/core";
import { z } from "zod";

export const greet = operation({
  label: "greet",
  input: z.object({ name: z.string().min(1) }),
  run: (_deps, { input }) => ({ text: `Hello, ${input.name}.` }),
});
