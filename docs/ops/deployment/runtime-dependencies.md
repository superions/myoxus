# Runtime dependencies

[Documentation](../../README.md) / [Operations](../README.md) / [Deployment](./README.md)

Machine-readable inventory: [runtime-dependencies.json](./runtime-dependencies.json)

## Required

- PostgreSQL reachable with sufficient privileges
- Redis reachable for at least the `session`, `queue`, and `lock` roles
- Myoxus binary (`myoxus-server`)
- Configuration (`server/config/default.yaml`, optionally
  `server/config/local.yaml`, plus environment overrides)
- Blob-storage backend (`local`, `s3`, or `r2`)

## Startup fail-fast checks

Startup verifies, among other requirements:

- database connectivity, schema, and privileges;
- Redis availability for the `session`, `queue`, and `lock` role profiles, and
  for the optional `cache` and `socket` roles when configured;
- a blob write/read/delete probe;
- the local-storage path and free-space threshold.
