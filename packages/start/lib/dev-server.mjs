import { existsSync } from "node:fs";

import main from "#tinker/server-main";

import { createMainHost, registerDevMain, finishDevMain } from "./main-host.mjs";

let host;
let detach;
const root = import.meta.env.TINKER_APP_ROOT;

const close = async () => {
  const own = host;
  host = undefined;
  detach?.();

  detach = undefined;
  own?.stop(0);
  await own?.closed;
};

if (import.meta.hot) {
  import.meta.hot.dispose(close);
  import.meta.hot.on("vite:beforeFullReload", close);
}

export default {
  fetch: async (request) => {
    if (!host) {
      if (existsSync(".env")) process.loadEnvFile();
      host = createMainHost(main, {
        env: process.env,
        args: [],
        stdout: process.stdout,
        stderr: process.stderr,
        validate: (app) => {
          if (typeof app.fetch !== "function") throw new TypeError("server main must return fetch");
        },
      });
      const own = host;
      detach = registerDevMain(root, own);
      void own.closed.then((code) => {
        process.exitCode = code;
        if (host === own) void finishDevMain(root, own);
      });
    }
    const own = host;
    try {
      const app = await own.started;
      if (own.signal.aborted) return new Response("Command stopped", { status: 503 });
      return app.fetch(request);
    } catch (error) {
      await own.closed;
      if (host === own) host = undefined;
      throw error;
    }
  },
};
