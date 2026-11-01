# Server API documentation

[Documentation](../../README.md) / [API](../README.md)

The GraphQL reference is generated from the same compiled schema used by the
Rust server. It includes the schema's queries, mutations, nested fields, inputs,
enums, scalars, defaults, nullability and deprecations.

<details>
<summary>On this page</summary>

- [Reference](#reference)
- [Calling GraphQL](#calling-graphql)
- [Regeneration and verification](#regeneration-and-verification)
- [Other server transports](#other-server-transports)

</details>

## Reference

| Artifact                                            | Purpose                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| [GraphQL reference](./graphql/README.md)            | Browse operations and follow links between types                             |
| [GraphQL SDL](./schema.graphql)                     | Machine-readable schema for tooling and client generation                    |
| [Administration via API](./administration.md)       | Organization operations, membership, workspace assignments and import/export |
| [PDF production via API](./pdf-production.md)       | Template, branding, font and color-profile administration                    |
| [Git Sync via API](./git-sync.md)                   | Profiles, synchronization, conflicts and file inspection                     |
| [Template Registry via API](./template-registry.md) | Imports, publication, assignments, updates and job inspection                |

The snapshot describes the source revision containing these files. Compare it
with your deployed version when integrating. It preserves schema identifiers,
signatures, defaults, directives and deprecation reasons.

## Calling GraphQL

Send a JSON request to `POST /graphql` on your server. This minimal read-only
request checks the GraphQL transport without accessing workspace data:

```bash
curl --fail-with-body http://localhost:3001/graphql \
  -H 'Content-Type: application/json' \
  --data '{"query":"query ApiProbe { __typename }"}'
```

Successful HTTP transport does not imply a successful operation: inspect the
GraphQL response's `errors` as well as `data`. Protected operations require the
server's normal authentication and resource permissions. Type signatures do
not express every authorization rule, configuration constraint or runtime
validator. Administrative fields remain restricted even though they appear in
the published schema.

Compatibility fields in the schema are not a promise of an enabled feature.
In particular, Myoxus does not implement billing, payment or subscription
mechanics. Historical protocol identifiers are retained where the server
still exposes them.

## Regeneration and verification

From the repository root, with the repository Rust toolchain, Node 26 and
Yarn dependencies installed:

```bash
build/scripts/docs/generate-server-api.sh
build/scripts/test/run.sh --suite docs.server-api --strict
```

Generation compiles the small `export-graphql-schema` example and its server
dependencies, then exports the production schema without loading configuration,
starting HTTP, or connecting to PostgreSQL or Redis. The first build can take
several minutes; later builds reuse Cargo's cache. Generation needs no running
server, Docker, credentials or production data.

The matrix gate tests the generator and compares all generated files without
rewriting them. The Forgejo GraphQL workflow runs this gate alongside client
code-generation checks. Commit regenerated artifacts with schema changes.
Do not edit the generated files by hand.

For an already exported SDL file, the rendering step can also run independently:

```bash
node build/scripts/docs/generate-server-api.mjs --schema /path/to/schema.graphql
```

The generator lives in
[`build/scripts/docs/`](../../../build/scripts/docs/generate-server-api.sh),
and the schema exporter lives in
[`server/crates/api/`](../../../server/crates/api/examples/export-graphql-schema.rs).

## Other server transports

This reference covers GraphQL. It is not an OpenAPI specification and does not
describe REST payloads, file-transfer endpoints, WebSocket/Socket.IO messages,
SSE streams or the MCP protocol. HTTP route registration is available in the
[server router](../../../server/crates/api/src/lib.rs); operator-facing MCP
documentation is available in the [MCP guide](../../ops/integrations/mcp/README.md).
