import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

if (import.meta.main) {
  if (process.argv.includes("--child")) {
    const loaded = new Set();
    const hooks = registerHooks({
      load(url, context, nextLoad) {
        loaded.add(url);
        return nextLoad(url, context);
      },
    });
    await import("../src/backend/index.ts");
    hooks.deregister();
    const services = [...loaded].filter((url) =>
      /\/node_modules\/(?:pg|@electric-sql\/pglite|better-auth|nodemailer)(?:\/|$)/.test(url),
    );
    assert.deepEqual(
      services,
      [],
      "Public backend import loaded a native driver, auth library, or mail client",
    );
    process.stdout.write(
      "PASS: public backend import leaves drivers, auth, and SMTP unloaded; Drizzle table declarations are allowed.\n",
    );
  } else {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
      encoding: "utf8",
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0, "Fresh-process import check failed");
  }
}
