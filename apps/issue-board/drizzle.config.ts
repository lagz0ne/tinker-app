import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/backend/board.schema.server.ts",
    "./tinker/components/auth/schema.server.ts",
    "./tinker/components/sync/schema.ts",
    "./src/demo/backend/todos.schema.server.ts",
    "./src/demo/backend/sync.schema.server.ts",
  ],
  out: "./drizzle",
});
