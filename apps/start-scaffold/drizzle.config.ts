import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./tinker/components/demo/backend/schema.server.ts",
    "./tinker/components/demo/backend/todos.schema.server.ts",
    "./tinker/components/demo/backend/sync.schema.server.ts",
  ],
  out: "./drizzle",
});
