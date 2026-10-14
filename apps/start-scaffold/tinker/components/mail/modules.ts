import { resource } from "@tinker/core";

export const smtp = resource({
  label: "module:nodemailer",
  target: "scope",
  factory: () => import("nodemailer"),
});
