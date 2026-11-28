import { capsule, operation, tag, type Operation } from "@tinkered/core";

import { letter, type Letter } from "./letter";

// The way out: the op that hands one letter to the mail server. It may throw (mail is down), and
// it may never answer (mail hangs). The cmd fills the slot with a provider capsule's op; a test
// fills it with a fake: `mailProvider({ provider: fake.send })`.

/** The slot: an op that takes a letter and answers when it has left. */
const provider = tag<Operation.Handle<Promise<void>, Letter>>({ label: "mail.provider" });

/** Hand one letter to the provider in the slot. */
const send = operation({
  label: "mail.provider.send",
  input: letter,
  depends: { provider },
  run: ({ provider }, { input }) => provider.run({ input }),
});

export const mailProvider = capsule({
  label: "mail.provider",
  config: { provider: provider.required },
  exports: { send },
});
