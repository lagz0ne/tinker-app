/** Temporary entry loader: avoid reading command slots until Start requests a router. */
export function loadRouterParts() {
  return import("./router-parts");
}
