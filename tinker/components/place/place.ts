import type { AnyRouter, RouterHistory } from "@tanstack/react-router";
import { data, tag } from "@tinkered/core";
import { z } from "zod";

/**
 * The route's search, as the page's own route parses it (`validateSearch`): the place the address names, and only
 * that. A default here would be a place the address never named, and TanStack writes a route's validated search back
 * into the address on a load, so an invented place would ride beside a link's own params and win over them.
 */
export const placeSearch = z.object({ place: z.string().min(1).optional().catch(undefined) });

/** A place's name: the address's `place`, or one the caller goes to. */
export const placeName = z.string().min(1);

/**
 * What the page needs of the browser's address: where it is, and how to walk it. TanStack's own `RouterHistory`
 * keeps all four (its `location` carries the search and the open entry's state), so the page binds the router's
 * history and a test binds a memory one, with no DOM either way.
 */
export type PlaceAddress = Pick<RouterHistory, "location" | "replace" | "go" | "subscribe">;

/**
 * The page's router: a place changes only through `router.navigate` (`./operations.ts`, `place.navigate`), so the
 * address's `place` search param is the one truth and Back is the router's own entry walk.
 */
export const placeRouter = tag<AnyRouter>({ label: "place.router" });

/** The browser's address and history: the page binds its router's own (`router.history`), a test a memory one. */
export const placeAddress = tag<PlaceAddress>({ label: "place.address" });

/**
 * The place the address names, read from it: `null` when the address names none. One op writes it
 * (`place.write`), and one op reads the address it came from (`place.read`), so a place change is the URL's. A
 * `null` is each app's own landing view to draw: this component never invents a place for an address.
 */
export const placeNow = data<string | null>({ label: "place.now", initial: null });

/**
 * The places pushed behind the open entry, in the order they were pushed: the page reads them from the entry's own
 * state, so a reload keeps Back working and no dead entry is walked.
 */
export const placeStack = data<readonly string[]>({ label: "place.stack", initial: [] });

/** A leave is under way: the walk back is out, and the one move it brings is not a Back to act on. */
export const placeLeaving = data<boolean>({ label: "place.leaving", initial: false });
