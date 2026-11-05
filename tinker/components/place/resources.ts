import { resource } from "@tinker/core";

import { placeRead, placeMoved, placeWrite } from "./operations";
import { placeAddress } from "./place";

/**
 * The page opens on the place its address names: the open reads the address and writes the cells. It does not
 * navigate. An address that names no place stays no place (the caller draws its own landing view), and the screens
 * come back from the open entry's own state, so a reload keeps Back working.
 */
export const placeOpen = resource({
  label: "place.open",
  target: "session",
  depends: { read: placeRead.controller, write: placeWrite.controller },
  factory: ({ read, write }) => {
    write.run({ input: read.run() });
  },
});

/**
 * The browser's move notice, the page's one listener: a move the browser walked (Back, Forward, a `go`) runs
 * `place.moved`. A push or a replace is the page's own write (`place.navigate`, `place.clean`), which reads the
 * address itself, so it is let go here. The stop is the resource's cleanup.
 */
export const placeHistory = resource({
  label: "place.history",
  target: "session",
  depends: { address: placeAddress.required, moved: placeMoved.controller },
  factory: ({ address, moved }, { defer }) => {
    defer(
      address.subscribe(({ action }) => {
        if (action.type === "PUSH" || action.type === "REPLACE") return;

        moved.run();
      }),
    );
  },
});
