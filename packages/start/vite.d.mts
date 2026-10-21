import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { PluginOption } from "vite-plus";

type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;

/** Start's static output options. Partial keeps each one optional when TanStack is not
 * installed, as in a CLI-only app, where StartOptions is `any`. */
type StaticOptions = Partial<Pick<StartOptions, "prerender" | "pages" | "spa" | "sitemap">>;

/** The glue: one call in the app's vite.config.ts joins the app to the base (ADR 0106). */
export declare function tinker(
  options: {
    /** The app-owned command files, relative to the app folder. A CLI-only app leaves
     * these three out and names only `cliEntry`. */
    serverEntry?: string;
    routerEntry?: string;
    startEntry?: string;
    /** Optional process commands, each with its matching vite.<role>.config file. */
    workerEntry?: string;
    cliEntry?: string;
    root?: string;
    /** Chrome compiles the client entry eagerly; on by default. */
    compileHints?: boolean;
  } & StaticOptions,
): PluginOption[];
