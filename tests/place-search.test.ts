import { createScope } from "@tinkered/core";
import { expect, test } from "vite-plus/test";

import { placeGo, placeHistory, placeNow, placeOpen, placeStack } from "~/components/place";

import { placePageOpened, placeTags } from "./support/place";

// B2, turned around from the s18 proof `b2-push-reload.test.tsx`: a place change is the route's own search param and
// a TanStack navigation, so the page's loader (its state read) is not run a second time. The proof showed the page
// writing `history.pushState` itself: the router saw an entry it did not make, and read the whole page again.

test("B2: a place change is the address's search param, so the page's loader is not run again", async () => {
  const project = await placePageOpened();
  const atOpen = project.loads();
  const root = createScope({});
  const page = root.createSession({ tags: placeTags(project.router, project.history) });

  page.resolve(placeOpen);
  page.resolve(placeHistory);
  expect(page.resolve(placeNow)).toBeNull();

  // The place is the address, and the cells are the page's read of it: no second read of the page.
  await page.run(placeGo, { input: "checks" });
  expect(project.history.location.search).toBe("?place=checks");
  expect(page.resolve(placeNow)).toBe("checks");
  expect(page.resolve(placeStack)).toEqual(["checks"]);
  expect(project.loads()).toBe(atOpen);

  // The entry is the router's own: it is a new one, and its state names the screen behind it, so the stack comes back
  // on a reload. An address written by the page itself would leave the one entry it opened on.
  expect(project.history.length).toBe(2);
  expect(project.history.location.state).toMatchObject({ places: ["checks"], __TSR_index: 1 });

  // A second screen is a second entry: the stack grows, and the page is still not read again.
  await page.run(placeGo, { input: "detail" });
  expect(project.history.location.search).toBe("?place=detail");
  expect(page.resolve(placeStack)).toEqual(["checks", "detail"]);
  expect(project.loads()).toBe(atOpen);

  // Going to the place the page already shows is no move at all: no entry, no read.
  const length = project.history.length;

  await page.run(placeGo, { input: "detail" });
  expect(project.history.length).toBe(length);
  expect(project.loads()).toBe(atOpen);

  await page.close();
  await root.close();
  await project.close();
});
