import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
  },
  server: { host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4318) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [
    tanstackStart({
      importProtection: {
        behavior: "error",
        client: {
          files: [/\.server\./, /\/backend\//],
          specifiers: [
            "@tanstack/react-start/server",
            "pg",
            "nodemailer",
            "better-auth",
            "better-auth/adapters/**",
            "drizzle-orm/**",
            "@electric-sql/pglite",
          ],
        },
        server: { files: [/\.client\./] },
      },
    }),
    react(),
    tailwindcss(),
  ],
});
