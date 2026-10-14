import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

/** The base's own unit tests. Apps never load this file; they call tinker(). */
export default defineConfig({
  resolve: {
    alias: {
      "~/base/server": fileURLToPath(new URL("tests/fixtures/base/server.ts", import.meta.url)),
      "#tinker/telemetry-env": fileURLToPath(
        new URL("tests/fixtures/telemetry-env.ts", import.meta.url),
      ),
      "#tinker/parts.server": fileURLToPath(
        new URL("tests/fixtures/parts.off.server.ts", import.meta.url),
      ),
      "#tinker/server": fileURLToPath(new URL("tests/fixtures/app.server.ts", import.meta.url)),
      "#tinker/router": fileURLToPath(new URL("tests/fixtures/app.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
  },
});
