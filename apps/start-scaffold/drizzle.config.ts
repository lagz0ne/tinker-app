import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/backend/schema.ts",
    "./src/backend/todos.schema.ts",
    "./src/backend/sync.schema.ts",
  ],
  out: "./drizzle",
});
