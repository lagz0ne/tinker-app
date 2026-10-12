import { expect, test } from "vite-plus/test";

import { settings } from "@/backend/settings.server";

test("env becomes the typed tags mail and the database need, with no unit running", () => {
  const bindings = settings({
    DATABASE_URL: "postgres://app:secret@db.test:5432/app",
    SMTP_HOST: "mail.test",
    SMTP_PORT: "2525",
    SMTP_USER: "ada",
    SMTP_PASSWORD: "p@ss word",
    SMTP_FROM: "ada@example.com",
  });

  expect(bindings.map(({ tag, value }) => [tag.label, String(value)])).toEqual([
    ["database.url", "postgres://app:secret@db.test:5432/app"],
    ["mail.smtpUrl", "smtp://ada:p%40ss%20word@mail.test:2525"],
    ["mail.from", "ada@example.com"],
  ]);
});

test("a bad or missing key stops start with BadSettings naming each key", () => {
  expect(() => settings({ DATABASE_URL: "not a url", SMTP_PORT: "many" })).toThrow(
    expect.objectContaining({
      kind: "BadSettings",
      payload: { part: "app", keys: ["DATABASE_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_FROM"] },
    }),
  );
});

test("an IPv6 SMTP host gets brackets, and a port or host a URL refuses names its key", () => {
  const keys = {
    DATABASE_URL: "postgres://proof",
    SMTP_HOST: "::1",
    SMTP_PORT: "11025",
    SMTP_FROM: "ada@example.com",
  };

  expect(String(settings(keys)[1]?.value)).toBe("smtp://[::1]:11025");
  expect(() => settings({ ...keys, SMTP_PORT: "65536" })).toThrow(
    expect.objectContaining({ payload: { part: "app", keys: ["SMTP_PORT"] } }),
  );
  expect(() => settings({ ...keys, SMTP_HOST: "mail test" })).toThrow(
    expect.objectContaining({ payload: { part: "app", keys: ["SMTP_HOST"] } }),
  );
});
