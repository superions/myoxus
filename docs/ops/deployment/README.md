# Install and deploy Myoxus

[Documentation](../../README.md) / [Operations](../README.md)

Choose between containers and a native Linux server installation, then select
the topology that fits your workload. Native DEB/APT and RPM packages are
available alongside the container route; the
[GitHub download overview](../../user/downloads.md) records actual availability.
The same Rust server can serve one host, separated services or multiple
application nodes sharing central data services.

## Plan the layout

| Guide                                             | Use it for                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Scaling overview](./scaling.md)                  | The growth path from self-hosting to a private cloud, with architecture diagrams |
| [Sizing](./sizing.md)                             | Initial CPU, RAM and storage estimates, followed by measured adjustment          |
| [Runtime overview](./runtime-overview.md)         | Service roles, ports, deployment mode and health endpoints                       |
| [Runtime dependencies](./runtime-dependencies.md) | Required external services and optional tools                                    |

## Install and operate

| Installation                  | Guide                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Single-host containers        | [Docker](./docker.md)                                                                                           |
| Native server DEB/APT and RPM | [Package status and supported distributions](../getting-started/installation-decision.md#distribution-packages) |
| Container orchestration       | [Docker Swarm](./swarm.md)                                                                                      |
| Native server from source     | [Linux/systemd source installation](./systemd/README.md)                                                        |
| Multiple application nodes    | [Multi-instance cluster](./multi-instance.md)                                                                   |
| Public edge and TLS           | [Reverse proxy](./reverse-proxy.md)                                                                             |
| Materialized Web/Admin assets | [Prebuilt frontend artifacts](./prebuilt-images.md)                                                             |

Use [Getting started](../getting-started/README.md) for the first installation.
Configuration ownership belongs to [Configuration](../configuration/README.md);
recovery procedures belong to [Backup and restore](../data/backup-and-restore.md).
