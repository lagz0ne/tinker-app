// The fallback type of a Reylo `.sql` import, for tools without content mappers: tsgolint
// (TypeScript 7.0) reads a query as a Reylo query of any row. The type check (TypeScript 7.1 with
// --runExternalCode) resolves each `.sql` file through Reylo first, so this never replaces the
// real params and row types there.
declare module "*.sql" {
  import type { Cardinality, Query } from "reylo";

  const query: Query<any, any, Cardinality, "sqlite">;
  export default query;
}
