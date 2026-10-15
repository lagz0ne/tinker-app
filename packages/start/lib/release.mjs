/**
 * One tag names the three packages tested together (ADR 0106).
 * @param {string} version - From argv; why: reject a path instead of a release version.
 * @param {string} origin - From the local proof; why: serve GitHub's paths on loopback.
 */
export function releaseUrls(version, origin = "https://github.com") {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("release version must be X.Y.Z, for example 0.7.0");
  }
  return Object.fromEntries(
    ["core", "react", "start"].map((name) => [
      `@tinker/${name}`,
      `${origin}/lagz0ne/tinkered/releases/download/start-v${version}/tinker-${name}-${version}.tgz`,
    ]),
  );
}
