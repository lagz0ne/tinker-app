import { expect, test } from "bun:test";

import { createScope } from "@tinker/core";

import {
  placeGo,
  placeHistory,
  placeLeave,
  placeNow,
  placeOpen,
  placeSetView,
  placeStack,
} from "~/components/place";

import { placeFlush, placePageOpened, placeTags } from "./support/place";

// B6, turned around from the s18 proof `b4-b6-frame.test.ts`: a screen is an entry a person pushed, so a view an
// outside asked for (`set view`) moves the place without an entry or a screen of its own. The proof showed the other
// side of it: a steer that opened a screen nobody pushed, which no Back could close.

test("B6: an outside set view moves the place without an entry or a screen of its own", async () => {
  const project = await placePageOpened();
  const root = createScope({});
  const page = root.createSession({ tags: placeTags(project.router, project.history) });

  page.resolve(placeOpen);
  page.resolve(placeHistory);
  await page.run(placeGo, { input: "list" });
  expect(project.history.length).toBe(2);
  expect(page.resolve(placeStack)).toEqual(["list"]);

  // The outside asks for another place: the address names it through the router, and the entry a person made is the
  // one that is rewritten. No entry, no screen.
  await page.run(placeSetView, { input: "detail" });
  expect(project.history.location.search).toBe("?place=detail");
  expect(project.history.length).toBe(2);
  expect(page.resolve(placeNow)).toBe("detail");
  expect(page.resolve(placeStack)).toEqual(["list"]);

  // The steer is not a screen: leaving closes the screen the person pushed, and lands on the address that names no
  // place, which is the caller's own landing view.
  await page.run(placeLeave);
  await placeFlush();
  expect(page.resolve(placeNow)).toBeNull();
  expect(page.resolve(placeStack)).toEqual([]);
  expect(project.history.location.search).toBe("");

  await page.close();
  await root.close();
  await project.close();
});

test("B6: a set view for the place the page already shows moves nothing", async () => {
  const project = await placePageOpened();
  const root = createScope({});
  const page = root.createSession({ tags: placeTags(project.router, project.history) });

  page.resolve(placeOpen);
  page.resolve(placeHistory);
  await page.run(placeGo, { input: "list" });
  const length = project.history.length;

  await page.run(placeSetView, { input: "list" });
  expect(project.history.length).toBe(length);
  expect(page.resolve(placeNow)).toBe("list");
  expect(page.resolve(placeStack)).toEqual(["list"]);

  await page.close();
  await root.close();
  await project.close();
});
