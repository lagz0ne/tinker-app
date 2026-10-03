import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";
const message = z.strictObject({ to: z.string(), subject: z.string(), text: z.string() });
export declare namespace Mail {
  type Message = z.infer<typeof message>;
  type Sender = { send: (message: Message) => Promise<void> };
  type Settings = { host: string; port: number; user: string; password: string; from: string };
}
export const mailSettings = tag<Mail.Settings>({ label: "mail.settings" });
export const mail = resource({
  label: "mail.sender",
  depends: { settings: mailSettings },
  factory: async ({ settings }, ctx): Promise<Mail.Sender> => {
    const { default: nodemailer } = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
    });
    ctx.defer(() => transport.close());
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
  run: async ({ mail }, ctx) => {
    await mail.send(ctx.input);
    ctx.log("mail.completed");
  },
});
