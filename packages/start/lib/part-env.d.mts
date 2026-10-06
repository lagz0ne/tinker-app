/** What a part's env rule accepts, and how doctor names it. A key with no rule takes any text. */
export declare const rules: Record<string, { wants: string; accepts(value: string): boolean }>;
/** A part's settings from env, read once: each key's set value, else its default. */
export declare function readPartEnv<K extends string>(
  keys: Record<K, { default?: string; rule?: string }>,
  env: Readonly<Record<string, string | undefined>>,
): { values: Record<K, string>; refused: K[] };
