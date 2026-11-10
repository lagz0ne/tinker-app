// Dev: the page on Vite (`bun --bun vp dev`, Fast Refresh), the server on Bun (`bun --hot cmds/api.ts`).
// Vite proxies /rpc (the socket) and /api to Bun, so the socket is Bun's own, as when built.
// The socket's Origin check sees Vite's origin, so that is the public origin here.
const apiPort = process.env.API_PORT ?? "3001";
const devPort = process.env.DEV_PORT ?? "5173";

const env = {
  ...process.env,
  PORT: apiPort,
  API_PORT: apiPort,
  DEV_PORT: devPort,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || `http://localhost:${devPort}`,
};

const server = Bun.spawn([process.execPath, "--hot", "cmds/api.ts"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

// Vite too runs on Bun: `vp` starts with a node shebang, and `--bun` overrides it.
const page = Bun.spawn([process.execPath, "--bun", "vp", "dev"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const halves = [server, page];

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    for (const half of halves) half.kill(signal);
  });
}

// One half ending ends the other: dev is both or neither.
const code = await Promise.race([server.exited, page.exited]);
for (const half of halves) half.kill();
process.exit(code);

export {};
