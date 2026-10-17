/** Core and React stay on the tinkered release that Start was tested with. */
export const coreRelease = "0.8.0";

/**
 * A tinker-app tag holds Start only; Core and React keep their tinkered release.
 * @param {string} version - From argv; why: reject a path instead of a release version.
 * @param {string} origin - From the local proof; why: serve GitHub's paths on loopback.
 */
export function releaseUrls(version, origin = "https://github.com") {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("release version must be X.Y.Z, for example 0.7.0");
  }
  const tinkered = `${origin}/lagz0ne/tinkered/releases/download/start-v${coreRelease}`;
  return {
    "@tinker/core": `${tinkered}/tinker-core-${coreRelease}.tgz`,
    "@tinker/react": `${tinkered}/tinker-react-${coreRelease}.tgz`,
    "@tinker/start": `${origin}/lagz0ne/tinker-app/releases/download/start-v${version}/tinker-start-${version}.tgz`,
  };
}
