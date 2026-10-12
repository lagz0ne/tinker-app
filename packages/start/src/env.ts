import type { Tag } from "@tinker/core";

export declare namespace Env {
  /** The process environment, as the server entry copies it once. */
  type Values = Readonly<Record<string, string | undefined>>;
  /**
   * How env becomes typed settings tags at the scope's door (ADR 0113): the server seam's
   * `settings`, and each base part's. No unit depends on env.
   */
  type Read = (env: Values) => Tag.Bindings;
}
