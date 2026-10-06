/** What a part's env rule accepts, and how doctor names it. A key with no rule takes any text. */
export const rules = {
  http: {
    wants: "an http(s) URL",
    accepts: (value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol),
  },
  secret: {
    wants: "at least 32 characters",
    accepts: (value) => value.length >= 32,
  },
};

/**
 * A part's settings from env, read once: each key's set value, else its default. An empty value
 * counts as unset, as doctor's env check reads it. A key with no default must be set. The keys
 * that are unset or break their rule are listed, so the part raises once with all of them.
 * No Node import: the browser bundle reads it.
 * @param {Record<string, { default?: string, rule?: string }>} keys - From the base's package.json part table; why: the part's keys, defaults, and rules.
 * @param {Readonly<Record<string, string | undefined>>} env - From the env tag, or doctor's .env and shell; why: the values to read.
 */
export function readPartEnv(keys, env) {
  const values = {};
  const refused = [];
  for (const [key, { default: fallback, rule }] of Object.entries(keys)) {
    values[key] = env[key] || fallback;
    if (values[key] === undefined || (rule && !rules[rule].accepts(values[key]))) refused.push(key);
  }
  return { values, refused };
}
