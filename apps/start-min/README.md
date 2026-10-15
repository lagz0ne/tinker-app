# Small Start app

Run `npm install`, `npm run dev`, and `npm run doctor`.
Runtime source is copied under `tinker/`. Commands own its wiring.
Core and React stay packages. Start is the build and host dev dependency.

The server command accepts LOG_LEVEL as 20 (debug), 30 (info), 40 (warn), or 50 (error).
A bad value fails start and names telemetry.logLevel.

The server command exports only async main, with no saved state or startup on import.
`tinker serve` calls and awaits main once before listening, so bad config fails boot.
The dev host starts on its first request, shares one startup promise, and retries a failed start.
The returned handler closes app, then telemetry. The dev host closes it on HMR reload.
