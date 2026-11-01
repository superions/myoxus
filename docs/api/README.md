# API documentation

[Documentation](../README.md)

API guides, machine-readable contracts and generated reference documentation
for the Myoxus server.

## Subdirectories

| Directory                       | Contents                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`server/`](./server/README.md) | API administration guide, generated GraphQL reference and SDL, request basics and regeneration |

## Related

[Administration via API](./server/administration.md) covers organization
operations, memberships, workspace assignments and JSON/CSV interchange.
Use [PDF production via API](./server/pdf-production.md) and
[Git Sync via API](./server/git-sync.md) for those service-specific examples.
[Template Registry via API](./server/template-registry.md) covers central
template imports, publication and assignment.
For interactive administration, use the
[Admin frontend guide](../ops/administration/organization.md).

The server reference is generated from the Rust server's compiled GraphQL
schema. REST and streaming transports are not yet covered by a generated
reference. See the server guide for the precise scope and verification command.
