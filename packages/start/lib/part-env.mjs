/** What a part's env rule accepts, and how doctor names it. A key with no rule takes any text. */
export const rules = {
  http: {
    wants: "an http(s) URL",
    accepts: (value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol),
  },
};

/**
 * A part's settings from env, read once: each key's set value, else its default. An empty value
 * counts as unset, as doctor's env check reads it. The keys whose value breaks their rule are
 * listed, so the part raises once with all of them. No Node import: the browser bundle reads it.
 * @param {Record<string, { default: string, rule?: string }>} keys - From the base's package.json part table; why: the part's keys, defaults, and rules.
 * @param {Readonly<Record<string, string | undefined>>} env - From the env tag, or doctor's .env and shell; why: the values to read.
 */
export function readPartEnv(keys, env) {
  const values = {};
  const refused = [];
  for (const [key, { default: fallback, rule }] of Object.entries(keys)) {
    values[key] = env[key] || fallback;
    if (rule && !rules[rule].accepts(values[key])) refused.push(key);
  }
  return { values, refused };
}
