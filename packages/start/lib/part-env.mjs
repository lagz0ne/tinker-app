import { z } from "zod";

/** What a part's env rule accepts, and how doctor names it. A key with no rule takes any text. */
export const rules = {
  url: { wants: "a URL", accepts: (value) => z.url().safeParse(value).success },
  email: { wants: "an email address", accepts: (value) => z.email().safeParse(value).success },
  port: {
    wants: "a whole port number, 1 to 65535",
    accepts: (value) => z.coerce.number().int().min(1).max(65535).safeParse(value).success,
  },
  smtpHost: {
    wants: "an SMTP host",
    accepts: (value) =>
      value.length > 0 && URL.canParse(`smtp://${value.includes(":") ? `[${value}]` : value}:25`),
  },
  http: {
    wants: "an http(s) URL",
    accepts: (value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol),
  },
  secret: {
    wants: "at least 32 characters",
    accepts: (value) => value.length >= 32,
  },
  level: {
    wants: "debug, info, warn, or error",
    accepts: (value) => ["debug", "info", "warn", "error"].includes(value),
  },
  count: {
    wants: "a whole number, 0 or more",
    accepts: (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
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
