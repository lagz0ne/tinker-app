import { expect, test } from "bun:test";

import { createScope } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";

import {
  placeAddress,
  placeGo,
  placeHistory,
  placeLeaving,
  placeLeave,
  placeNow,
  placeOpen,
  placeRouter,
  placeStack,
  type PlaceAddress,
} from "~/components/place";

import { placeFlush, placePageOpened, placePageReloaded, placeTags } from "./support/place";

// B4, turned around from the s18 proof `b4-b6-frame.test.ts`: the screens behind the open entry are the entry's own
// state, so a reload keeps Back working and no dead entry is walked; and a leave whose move never comes gives up, so
// the next real Back is not eaten. The proof showed a stack the page started empty (Back walked a dead entry) and a
// leave that waited forever.

test("B4: a reload reads the stack from the entry's state, so Back keeps working and walks no dead entry", async () => {
  const project = await placePageOpened();
  const root = createScope({});
  const before = root.createSession({ tags: placeTags(project.router, project.history) });

  before.resolve(placeOpen);
  before.resolve(placeHistory);
  await before.run(placeGo, { input: "notice" });
  await before.run(placeGo, { input: "checks" });
  expect(before.resolve(placeStack)).toEqual(["notice", "checks"]);
  expect(project.history.location.state).toMatchObject({ places: ["notice", "checks"] });
  await before.close();

  // The reload: the page's own memory is gone (a new router, a new session), the browser's history is not.
  const reloaded = await placePageReloaded(project.history);
  const after = root.createSession({ tags: placeTags(reloaded, project.history) });

  after.resolve(placeOpen);
  after.resolve(placeHistory);
  expect(after.resolve(placeNow)).toBe("checks");
  expect(after.resolve(placeStack)).toEqual(["notice", "checks"]);

  // Back: the entry below names Notice and the one screen behind it. Without the state read the stack was empty, and
  // this was a dead entry: the browser moved and the page stayed where it was.
  project.history.go(-1);
  await placeFlush();
  expect(after.resolve(placeNow)).toBe("notice");
  expect(after.resolve(placeStack)).toEqual(["notice"]);

  await after.close();
  await root.close();
});

test("B4: a leave whose move never comes gives up after 600 ms, so the next real Back is not eaten", async () => {
  const clock = makeTestClock();
  const project = await placePageOpened();
  const root = createScope({ clock });

  // A browser that drops the move its walk asks for: the address stays where it is, and nobody answers the wait.
  const dropped: PlaceAddress = {
    get location() {
      return project.history.location;
    },
    replace: (path, state) => project.history.replace(path, state),
    go: () => undefined,
    subscribe: (moved) => project.history.subscribe(moved),
  };

  const page = root.createSession({
    tags: [placeRouter(project.router), placeAddress(dropped)],
  });

  page.resolve(placeOpen);
  page.resolve(placeHistory);
  await page.run(placeGo, { input: "notice" });
  await page.run(placeGo, { input: "checks" });

  const leaving = page.run(placeLeave);

  await placeFlush();
  expect(page.resolve(placeLeaving)).toBe(true);

  // 600 ms later the wait gives up: `place.leaving` goes, and the page is not held. Without the give-up the leave
  // waits for a move that never comes, and this is still true.
  clock.advance(600);
  await Promise.race([leaving, new Promise((resolve) => setTimeout(resolve, 100))]);
  await placeFlush();
  expect(page.resolve(placeLeaving)).toBe(false);

  // The next real Back is a Back: the entry below names Notice and the one screen behind it.
  project.history.go(-1);
  await placeFlush();
  expect(page.resolve(placeNow)).toBe("notice");
  expect(page.resolve(placeStack)).toEqual(["notice"]);

  await page.close();
  await root.close();
});
