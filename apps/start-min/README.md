# Small Start app

Run `npm install`, `npm run dev`, and `npm run doctor`.
Runtime source is copied under `tinker/`. Commands own its wiring.
Core and React stay packages. Start is the build and host dev dependency.

The server command accepts LOG_LEVEL as 20 (debug), 30 (info), 40 (warn), or 50 (error).
A bad value fails start and names telemetry.logLevel.

The server command exports start, fetch, and close callbacks without starting on import.
`tinker serve` awaits start before listening, so bad config fails boot.
Dev starts on its first request. Failed startup clears the cache for the next request.
Close before start does nothing; after start it closes app, then telemetry.
