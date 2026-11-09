import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { placeClean, placeNow, placeOpen } from "~/components/place";

import { placePageOpened, placePageReloaded, placeTags } from "./support/place";

// B3, turned around from the s18 proof `b3-url-sticks.test.ts`: the params a link names open the page once, and the
// address then stops naming them, so a later open reads the person's own choice instead of the link's. The proof
// showed the opposite: the address kept them, and the link won again on every open.

test("B3: a link's one-time params open the page once, then leave the address", async () => {
  const project = await placePageOpened(["/p/shop/?story=a&find=p2"]);
  const atOpen = project.loads();
  const length = project.history.length;
  const root = createScope({});
  const page = root.createSession({ tags: placeTags(project.router, project.history) });

  page.resolve(placeOpen);

  // The link's params are in the address for the caller to use, and the address names no place: none is invented.
  const link = new URLSearchParams(project.history.location.search);

  expect(page.resolve(placeNow)).toBeNull();
  expect(link.get("story")).toBe("a");
  expect(link.get("find")).toBe("p2");

  // The caller has used them: the names leave the address, and the place the page opened stays named.
  page.run(placeClean, { input: { names: ["story", "find"], place: "detail" } });
  expect(project.history.location.search).toBe("?place=detail");
  expect(page.resolve(placeNow)).toBe("detail");
  // A replace, not a push: the entry the link opened is the entry the page keeps, and the page is not read again.
  expect(project.history.length).toBe(length);
  expect(project.loads()).toBe(atOpen);

  // Cleaning again finds nothing to take out: no second write to the address.
  page.run(placeClean, { input: { names: ["story", "find"], place: "detail" } });
  expect(project.history.location.search).toBe("?place=detail");
  await page.close();
  // The first page is stopped before the second opens, so only the page under test listens to the address.
  await project.close();

  // A later open reads the place and the person's own choice: the link does not win a second time.
  const reloaded = await placePageReloaded(project.history);
  const again = root.createSession({ tags: placeTags(reloaded.router, project.history) });

  again.resolve(placeOpen);
  expect(again.resolve(placeNow)).toBe("detail");
  expect(new URLSearchParams(project.history.location.search).get("story")).toBeNull();

  await again.close();
  await root.close();
  await reloaded.close();
});
