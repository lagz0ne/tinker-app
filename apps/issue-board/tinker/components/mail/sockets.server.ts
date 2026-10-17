import type { Socket } from "node:net";

import { resource } from "@tinker/core";
import type { GetSocketCallback } from "nodemailer/lib/mailer";

import { smtpUrl } from "./mail.server";
import { smtpNet } from "./modules";

/** The SMTP pool owns protocol state; this resource owns its cancellable TCP sockets. */
export const smtpSockets = resource({
  label: "mail.sockets",
  depends: { net: smtpNet, url: smtpUrl },
  factory: async ({ net, url }, { defer }) => {
    const sockets = new Set<Socket>();
    defer(() => {
      for (const socket of sockets) socket.destroy();
    });
    return {
      getSocket(this: void, _options: unknown, callback: GetSocketCallback) {
        const socket = net.createConnection({
          host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
          port: url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587,
        });

        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        socket.once("error", callback);
        socket.once("connect", () => {
          socket.removeListener("error", callback);
          callback(null, { connection: socket });
        });
      },
      abort() {
        for (const socket of sockets) socket.destroy(new Error("Alert send total timeout"));
      },
    };
  },
});
