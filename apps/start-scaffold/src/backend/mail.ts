import { operation, resource } from "@tinker/core";
import { z } from "zod";
import { raise } from "../errors";

const message = z.strictObject({ to: z.string(), subject: z.string(), text: z.string() });

export declare namespace Mail {
  type Message = z.infer<typeof message>;
  type Sender = { send: (message: Message) => Promise<void> };
  type Settings = { host: string; port: number; user: string; password: string; from: string };
}

import { env } from "@tinker/start/server";

const mailEnv = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  SMTP_FROM: z.email(),
});

export const mailSettings = resource({
  label: "mail.settings",
  depends: { env },
  factory: ({ env }): Mail.Settings => {
    const parsed = mailEnv.safeParse(env);
    if (!parsed.success)
      raise("BadSettings", {
        part: "mail",
        keys: parsed.error.issues.map((issue) => issue.path.join(".")),
      });
    const settings = parsed.data;
    return {
      host: settings.SMTP_HOST,
      port: settings.SMTP_PORT,
      user: settings.SMTP_USER,
      password: settings.SMTP_PASSWORD,
      from: settings.SMTP_FROM,
    };
  },
});

export const mail = resource({
  label: "mail.sender",
  depends: { settings: mailSettings },
  factory: async ({ settings }, { defer }): Promise<Mail.Sender> => {
    const { default: nodemailer } = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
    });
    defer(() => transport.close());
    return {
      send: async (message) => {
        await transport.sendMail({ from: settings.from, ...message });
      },
    };
  },
});

export const sendMail = operation({
  label: "sendMail",
  input: message,
  depends: { mail },
  run: async ({ mail }, { input, log }) => {
    await mail.send(input);
    log("mail.completed");
  },
});
