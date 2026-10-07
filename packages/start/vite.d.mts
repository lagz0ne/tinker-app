import type { PluginOption } from "vite-plus";
import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;
/** The glue: one call in the app's vite.config.ts joins the app to the base (ADR 0106). */
export declare function tinker(
  options?: {
    root?: string;
    /** Chrome compiles the client entry eagerly; on by default. */
    compileHints?: boolean;
    /** The telemetry part: on by default; off frees `/api/telemetry` for the app. */
    telemetry?: boolean;
    /** The auth part: off by default; on mounts `/api/auth/$` and reads the server seam. */
    auth?: boolean;
    /** The sync part: off by default; on mounts `/api/sync`, and turns auth on. */
    sync?: boolean;
  } & Pick<StartOptions, "prerender" | "pages" | "spa" | "sitemap">,
): PluginOption[];
