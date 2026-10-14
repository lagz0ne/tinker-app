import { tinker } from "@tinker/start/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tinker({ serverEntry: "cmds/server.ts", auth: true, sync: true })],
});
