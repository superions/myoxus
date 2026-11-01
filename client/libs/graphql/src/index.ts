/**
 * @file index.ts — @myoxus/graphql
 *
 * Public entry-point for the `@myoxus/graphql` package.
 *
 * Re-exports:
 *  - `./fetcher`  — HTTP transport, type helpers, and {@link gqlFetcherFactory}
 *  - `./graphql`  — Generated GraphQL query/mutation definitions and fragments
 *  - `./schema`   — Generated TypeScript types derived from the GraphQL schema
 *
 * Note: The generated files (`graphql/index.ts`, `schema.ts`) are NOT edited
 * manually.  Local adaptations live exclusively in `fetcher.ts`.
 */
export * from "./fetcher";
export * from "./graphql";
export * from "./operations";
export * from "./schema";
