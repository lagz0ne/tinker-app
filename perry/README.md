# Perry trial: small app as one binary

Perry 0.5.1659 (main, 2026-10-18) and 0.5.1520 (npm).
App: `small` at start-v0.10.0.

## Result

- All 269 modules compile to native code.
- Two dependency patches are needed first.
- `/api/health` runs and gives the right body.
- `/` (React SSR) fails: Perry bug 3 in TanStack Router.
- The binary skips the per-request span logs.

## Run it

```bash
vp build
perry compile perry/host.ts -o small.bin
NODE_ENV=production PATHS=/api/health ./small.bin
```

`host.ts` starts `cmds/server.ts` in process and calls
`fetch` N times. No socket.

## Perry bugs (minimal repros)

- `repros/bug1-array-push.ts`: an array made from an
  object literal, then `push()`, fails to compile.
- `repros/bug2-getrandomvalues.ts`: on an `Int32Array`,
  `crypto.getRandomValues` does not fill it.
- `repros/bug3/`: an arrow field from another module
  that calls `this.other()` throws in a subclass.

## Patches used

- `patches/router-core-workaround.diff` (bug 1)
- `patches/tinker-core-getrandomvalues.diff` (bug 2)
