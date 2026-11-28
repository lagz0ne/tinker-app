import { capsule, operation, tag } from "@tinkered/core";

import { letter } from "./letter";

// A provider with no mail server: it writes each letter to a stream, as one line
// (`mail to bo: Welcome to ENG`).

/** Where the lines go: the cmd's stdout. */
const out = tag<{ write: (line: string) => unknown }>({ label: "mail.stdout.out" });

/** Write one letter's line. */
const write = operation({
  label: "mail.stdout.write",
  input: letter,
  depends: { out },
  run: async ({ out }, { input }) => {
    out.write(`mail to ${input.to}: ${input.subject}\n`);
  },
});

export const stdoutMail = capsule({
  label: "mail.stdout",
  config: { out: out.required },
  exports: { write },
});
