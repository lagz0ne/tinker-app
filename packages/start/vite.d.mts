import type { PluginOption } from "vite-plus";
import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;
/** The glue: one call in the app's vite.config.ts joins the app to the base (ADR 0106). */
export declare function tinker(
  options?: { root?: string } & Pick<StartOptions, "prerender" | "pages" | "spa" | "sitemap">,
): PluginOption[];
