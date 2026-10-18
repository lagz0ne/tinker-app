import { resource } from "@tinker/core";

export const smtp = resource({
  label: "module:nodemailer",
  target: "scope",
  factory: () => import("nodemailer"),
});

/** SMTP owns these sockets so a total deadline can destroy an active send. */
export const smtpNet = resource({
  label: "module:node:net",
  target: "scope",
  factory: () => import("node:net"),
});

export const postgres = resource({
  label: "module:pg:mail",
  target: "scope",
  factory: () => import("pg"),
});
