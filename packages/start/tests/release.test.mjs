import { expect, test } from "vite-plus/test";
import { releaseDependencies, releaseUrls } from "../lib/release.mjs";

test("release URLs name all three tarballs under the same tag", () => {
  expect(releaseUrls("0.7.0")).toEqual({
    "@tinker/core":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.7.0/tinker-core-0.7.0.tgz",
    "@tinker/react":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.7.0/tinker-react-0.7.0.tgz",
    "@tinker/start":
      "https://github.com/lagz0ne/tinkered/releases/download/start-v0.7.0/tinker-start-0.7.0.tgz",
  });
});

test("the release rewrite replaces old specs and keeps other dependencies without editing its input", () => {
  const dependencies = {
    "@tinker/core": "workspace:*",
    "@tinker/react": "file:old.tgz",
    zod: "^4",
  };
  expect(releaseDependencies(dependencies, "0.8.0")).toEqual({
    ...releaseUrls("0.8.0"),
    zod: "^4",
  });
  expect(dependencies).toEqual({
    "@tinker/core": "workspace:*",
    "@tinker/react": "file:old.tgz",
    zod: "^4",
  });
});

test("a missing version or a path cannot name a release", () => {
  for (const version of [undefined, "", "../0.7.0", "0.7", "01.7.0"])
    expect(() => releaseUrls(version)).toThrow("release version must be X.Y.Z");
});
