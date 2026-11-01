// SPDX-License-Identifier: AGPL-3.0-or-later

const {
  assertValidSchema,
  buildASTSchema,
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  printSchema,
} = require("graphql");
const { readFile } = require("node:fs/promises");

/**
 * Load the runtime schema without dropping GraphQL OneOf metadata.
 *
 * The generic URL loader uses the default introspection query, which omits
 * `isOneOf`. Losing that bit silently widens generated discriminated input
 * unions, even though the server still enforces the OneOf contract.
 */
module.exports = async function loadRuntimeSchema(pointer) {
  const schemaFile = process.env.MYOXUS_GRAPHQL_SCHEMA_FILE;
  if (schemaFile !== undefined) {
    // The explicit native export is the sole input, including on failure.
    // Normalize through the same schema printer as introspection so implicit
    // standard scalar/directive descriptions do not cause transport-only drift.
    const schema = buildASTSchema(parse(await readFile(schemaFile, "utf8")));
    assertValidSchema(schema);
    return parse(printSchema(schema));
  }
  // Let isolated API verification use the same generator without replacing the
  // shared development server or editing the checked-in schema source.
  const origin = process.env.MYOXUS_CODEGEN_SERVER_ORIGIN;
  const schemaUrl = origin ? new URL("/graphql", origin).href : pointer;
  const response = await fetch(schemaUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // async-graphql exposes `isOneOf`, while intentionally retaining the
      // broadly compatible introspection shape for the other optional fields.
      query: getIntrospectionQuery({ oneOf: true }),
    }),
  });
  if (!response.ok) {
    throw new Error(
      `GraphQL introspection failed with HTTP ${response.status}`,
    );
  }
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(
      `GraphQL introspection failed: ${result.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  if (!result.data) {
    throw new Error("GraphQL introspection returned no schema data");
  }
  // Return an AST instead of the introspected GraphQLSchema. The codegen
  // loader otherwise reconstructs the schema and drops scalar descriptions.
  // printSchema retains both descriptions and the standard @oneOf marker.
  return parse(printSchema(buildClientSchema(result.data)));
};
