import { capsule, data, operation } from "@tinkered/core";

import { letter, type Letter } from "./letter";

// A backend that keeps each letter in a cell. It never fails.

/** Each letter this backend took, oldest first. */
const sent = data<Letter[]>({ label: "mail.memory.sent", initial: [] });

/** Keep one letter. */
const deliver = operation({
  label: "mail.memory.deliver",
  input: letter,
  depends: { sent: sent.controller },
  run: ({ sent }, { input }) => {
    sent.update((list) => [...list, input]);
  },
});

export const memoryMail = capsule({ label: "mail.memory", exports: { sent, deliver } });
