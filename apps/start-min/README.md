# Small Start app

Run `npm install`, `npm run dev`, and `npm run doctor`.
Runtime source is copied under `tinker/`. Commands own its wiring.
Core and React stay packages. Start is the build and host dev dependency.

The server command accepts LOG_LEVEL as 20 (debug), 30 (info), 40 (warn), or 50 (error).
A bad value fails start and names telemetry.logLevel.

The server command exports only async main, with no saved state or startup on import.
`tinker serve` calls and awaits main once before listening, so bad config fails boot.
The dev host starts on its first request, shares one startup promise, and retries a failed start.
The host calls `main({ env, signal, stdout, stderr })` once. The streams need only
`write(chunk: string): unknown`. The command reads no process globals and loads no env file.
It binds each value inline, for example `env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)`.
Main returns `{ fetch, closed }`. Aborting the host signal closes app, then telemetry.
The one `closed` promise reports app failure first, then the first teardown error.
A start error closes what started, writes cleanup errors to stderr, and rethrows the start error.
The Node host loads .env and stops accepting requests on SIGINT or SIGTERM.
The dev host owns startup sharing, retry after failure, and abort on HMR replacement.
