import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./tinker/components/auth/schema.server.ts",
    "./tinker/components/sync/schema.ts",
    "./tinker/components/demo/backend/todos.schema.server.ts",
    "./tinker/components/demo/backend/sync.schema.server.ts",
  ],
  out: "./drizzle",
});
