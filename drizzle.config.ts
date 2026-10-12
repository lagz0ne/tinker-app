import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/backend/schema.server.ts",
    "./src/backend/todos.schema.server.ts",
    "./src/backend/sync.schema.server.ts",
  ],
  out: "./drizzle",
});
