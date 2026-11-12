import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { placeNow, placeOpen, placeSearch } from "~/components/place";

import { placePageOpened, placeTags } from "./support/place";

// The root cause of the reverted fix (the place2 report): a `validateSearch` whose `place` defaulted. TanStack
// writes a route's validated search back into the address on a load, so an invented place rode beside a link's own
// params, and the page opened on the default instead of the view the link named. An address that names no place is
// left as it is: a place is only ever one the caller went to or the address named.

test("a URL that names no place is not given one", async () => {
  const project = await placePageOpened(["/p/shop/?story=a&find=p2"]);
  const location = project.history.location;

  // What a load writes back: the address's own search, with the route's validated search over it (the search
  // middleware TanStack runs for `validateSearch`, `router-core/router.js`).
  const raw: Record<string, unknown> = Object.fromEntries(new URLSearchParams(location.search));
  const again = project.router.buildLocation({
    to: location.pathname,
    search: { ...raw, ...placeSearch.parse(raw) },
  });

  expect(again.publicHref).not.toContain("place=");
  expect(new URL(again.publicHref, "http://localhost").searchParams.get("story")).toBe("a");

  // The page's own open invents none either: the cells say no place, and the address still says none.
  const root = createScope({});
  const page = root.createSession({ tags: placeTags(project.router, project.history) });

  page.resolve(placeOpen);
  expect(page.resolve(placeNow)).toBeNull();
  expect(project.history.location.search).toBe("?story=a&find=p2");

  await page.close();
  await root.close();
  await project.close();
});

test("a place the address cannot name is no place, not a default", async () => {
  const project = await placePageOpened(["/p/shop/?place="]);
  const root = createScope({});
  const page = root.createSession({ tags: placeTags(project.router, project.history) });

  page.resolve(placeOpen);
  expect(page.resolve(placeNow)).toBeNull();
  expect(placeSearch.parse({ place: "" })).toEqual({ place: undefined });

  await page.close();
  await root.close();
  await project.close();
});
