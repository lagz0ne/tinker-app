import type { Socket } from "node:net";

import { resource } from "@tinker/core";
import type { GetSocketCallback } from "nodemailer/lib/mailer";

import { smtpNet } from "./modules";
import { smtpUrl } from "./settings";

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
      open() {
        return new Set<Socket>();
      },
      getSocket(this: void, owned: Set<Socket>, _options: unknown, callback: GetSocketCallback) {
        const socket = net.createConnection({
          host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
          port: url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587,
        });

        owned.add(socket);
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => {
          owned.delete(socket);
          sockets.delete(socket);
        });
        socket.once("error", callback);
        socket.once("connect", () => {
          socket.removeListener("error", callback);
          callback(null, { connection: socket });
        });
      },
      close(owned: Set<Socket>, error?: Error) {
        for (const socket of owned) {
          owned.delete(socket);
          sockets.delete(socket);
          socket.destroy(error);
        }
      },
    };
  },
});
