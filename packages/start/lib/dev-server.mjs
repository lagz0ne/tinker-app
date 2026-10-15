import { existsSync } from "node:fs";

import main from "#tinker/server-main";

let started;
let stop;

const close = async () => {
  stop?.abort();
  const app = await started?.catch(() => undefined);
  await app?.closed;
};

if (import.meta.hot) {
  import.meta.hot.dispose(close);
  import.meta.hot.on("vite:beforeFullReload", close);
}

export default {
  fetch: async (request) => {
    if (!started) {
      stop = new AbortController();
      if (existsSync(".env")) process.loadEnvFile();
      started = main({
        env: process.env,
        signal: stop.signal,
        stdout: process.stdout,
        stderr: process.stderr,
      }).catch((error) => {
        started = undefined;
        throw error;
      });
    }
    return (await started).fetch(request);
  },
};
