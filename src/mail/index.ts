import { capsule, operation, tag, type Operation } from "@tinkered/core";

import { letter, type Letter } from "./letter";

// The app's mail. A feature calls `mail.send`; it never sees which backend sends. The cmd fills
// the backend slot with a backend capsule's op: `mail({ backend: memoryMail.deliver })`.

/** The slot: an op that takes a letter and gives no answer. */
const backend = tag<Operation.Handle<void, Letter>>({ label: "mail.backend" });

/** Send one letter through the backend. */
const send = operation({
  label: "mail.send",
  input: letter,
  depends: { backend },
  run: ({ backend }, { input }) => backend.run({ input }),
});

export const mail = capsule({
  label: "mail",
  config: { backend: backend.required },
  exports: { send },
});
