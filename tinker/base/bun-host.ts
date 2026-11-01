import type { HTMLBundle } from "bun";

import type { MainClosed, MainContext } from "./main";

type Main = (ctx: MainContext) => Promise<{
  fetch: (request: Request) => Promise<Response | undefined>;
  closed: MainClosed;
}>;

/** POSIX exit codes for a stop by signal: 128 plus the signal's number. */
const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * The host for one server command on Bun.serve. It owns OS signals and the exit code: a startup
 * throw exits 78 for a config error, else 1; a failed root exits 1; a signal exits 128 + its number.
 * SIGHUP (a closed terminal) stops it like SIGTERM: the port closes, the root closes, exit 129.
 * A command that calls `exit` during start gets that code and no port: the host never listens,
 * but still waits for `closed`. `/api/*`, `/rpc/*` and each of `options.paths` (Bun route
 * patterns, such as `/mcp` or `/.well-known/*`) go to the command; every other path gets the
 * page (the router owns it). `paths` adds to the two defaults; it never drops them.
 * `pages` are the client's routes: dev passes Bun's HTML import, a build its own files.
 */
export async function serveMain(
  main: Main,
  pages: Record<string, HTMLBundle | Response>,
  options: { paths?: readonly string[] } = {},
) {
  const stop = new AbortController();
  let code = 0;
  const exit = (next: number, reason?: unknown) => {
    const { kind, payload } = Object(reason);
    if (kind !== undefined) console.error(`tinker: ${kind} ${JSON.stringify(payload)}`);
    else if (reason !== undefined) console.error(reason);
    code ||= next;
    stop.abort(reason);
  };
  for (const [name, signalCode] of Object.entries(signalCodes)) {
    process.once(name, () => exit(signalCode));
  }

  const started = await main({
    env: process.env,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    signal: stop.signal,
    stdout: process.stdout,
    stderr: process.stderr,
    exit,
  }).catch((error: unknown) => {
    const config = ["MissingTag", "MissingConfig", "DataValidationFailed"].includes(
      Object(error).kind,
    );
    exit(config || Object(error).code === "ERR_INVALID_URL" ? 78 : 1, error);
  });
  if (!started) return process.exit(code);

  // A command that called `exit` during start (a usage error) gets no port, so no server here;
  // its root still closes.
  const servers = stop.signal.aborted
    ? []
    : [
        Bun.serve({
          port: Number(process.env.PORT ?? 4318),
          // Bun's 10 s default resets a quiet stream (SSE); 60 s (max 255) outlasts usual heartbeats.
          idleTimeout: 60,
          development: process.env.NODE_ENV !== "production" && { hmr: false, console: true },
          routes: {
            ...Object.fromEntries(
              ["/api/*", "/rpc/*", ...(options.paths ?? [])].map((path) => [
                path,
                async (request: Request) =>
                  (await started.fetch(request)) ?? new Response(null, { status: 404 }),
              ]),
            ),
            ...pages,
          },
        }),
      ];
  servers.forEach((server) => {
    console.log(`tinker: listening on ${server.url}`);
    stop.signal.addEventListener("abort", () => void server.stop());
  });

  // Root by root: a failed root exits 1 with its error, else its first teardown error.
  await started.closed.then((closed) => {
    const failure = [closed ?? []]
      .flat()
      .flatMap((end) => (end.status === "failed" ? [end.error] : (end.teardownErrors ?? [])))
      .at(0);
    if (failure !== undefined) exit(1, failure);
  });
  await Promise.all(servers.map((server) => server.stop()));
  process.exit(code);
}
