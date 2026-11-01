/**
 * @file index.ts — @myoxus/routes
 *
 * Public entry-point for the `@myoxus/routes` package.
 *
 * Re-exports:
 *  - `./routes` — {@link ROUTES}, {@link RELATIVE_ROUTES}, {@link FACTORIES},
 *                 and {@link RouteParamsTypes}.
 *  - `./lazy`   — {@link lazy} React code-splitting helper.
 *
 * Consumers: `client/admin`, `client/web`.
 */
export * from "./lazy";
export * from "./routes";
