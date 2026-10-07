import { defineConfig } from "vite-plus";
import { tinker } from "@tinker/start/vite";
export default defineConfig({
  plugins: [tinker({ auth: true, sync: true })],
});
