// The fallback type of a Reylo `.sql` import, for tsgolint only: the type-aware lint runs on
// TypeScript 7.0, which has no content mappers, so it reads a query as a Reylo query of any row.
// The type check (TypeScript 7.1 with --runExternalCode) resolves each `.sql` file through Reylo
// first, so this never replaces the real params and row types there. Without the `contentMappers`
// line in tsconfig.json, tsc would fall back to this type and pass; `maintain/sqlite-dev-db.mjs`,
// which the type check and the tests run first, stops with an error in that case.
declare module "*.sql" {
  import type { Cardinality, Query } from "reylo";

  const query: Query<any, any, Cardinality, "sqlite">;
  export default query;
}
