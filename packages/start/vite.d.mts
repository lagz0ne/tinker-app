import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { PluginOption } from "vite-plus";

type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;

/** The glue: one call in the app's vite.config.ts joins the app to the base (ADR 0106). */
export declare function tinker(
  options: {
    /** The app-owned command file, relative to the app folder. */
    serverEntry: string;
    root?: string;
    /** Chrome compiles the client entry eagerly; on by default. */
    compileHints?: boolean;
  } & Pick<StartOptions, "prerender" | "pages" | "spa" | "sitemap">,
): PluginOption[];
