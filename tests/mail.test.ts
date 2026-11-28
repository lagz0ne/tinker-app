import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { mail } from "@/mail";
import { memoryMail } from "@/mail/memory.server";
import { stdoutMail } from "@/mail/stdout.server";

// The given mail parts on their own: `mail.send` reaches the backend in its slot. The welcome
// mail's journeys (tries, waits, given up) are in issues-feature.test.ts.

test("mail.send gives each letter to the backend in its slot; the memory backend keeps it", async () => {
  const live = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      memoryMail(),
      mail({ backend: memoryMail.deliver }),
    ],
  }).ready;
  await live.run(mail.send, { input: { to: "bo", subject: "Hi", body: "Welcome" } });
  expect(live.resolve(memoryMail.sent).get()).toEqual([
    { to: "bo", subject: "Hi", body: "Welcome" },
  ]);
  await live.close();
});

test("the stdout provider writes one line for each letter", async () => {
  const lines: string[] = [];
  const live = await createScope({
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      stdoutMail({ out: { write: (line: string) => lines.push(line) } }),
    ],
  }).ready;
  await live.run(stdoutMail.write, { input: { to: "bo", subject: "Welcome to ENG", body: "Hi" } });
  expect(lines).toEqual(["mail to bo: Welcome to ENG\n"]);
  await live.close();
});
