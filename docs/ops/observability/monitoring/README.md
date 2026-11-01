# Monitoring

[Documentation](../../../README.md) / [Operations](../../README.md) / [Observability](../README.md)

Observability configuration for the Myoxus server: Prometheus alerts and Grafana dashboards.

## What gets scraped

The server exposes two scrape endpoints:

| Endpoint                  | Content                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics`            | JSON snapshot (uptime, request counts, queue stats) — internal format, not Prometheus.                                                         |
| `GET /metrics/prometheus` | Prometheus text format. Infrastructure counters + business counters `myoxus_metric_{category}_{name}…` when `metrics.prometheus_enabled=true`. |

Use the [metrics guide](../metrics.md) for collection, retention and diagnosis.

## Subdirectories

| Directory                               | Contents                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`grafana/`](./grafana/README.md)       | Grafana dashboard definitions — `observability-dashboard.json` (request/latency) and `business-metrics-dashboard.json` (uid `myoxus-business-metrics`) |
| [`prometheus/`](./prometheus/README.md) | Prometheus alert rule definitions — `alerts.yaml` (groups `myoxus-ops` and `myoxus-business`)                                                          |

## Deploy

1. Point your Prometheus at `/metrics/prometheus`:
   ```yaml
   - job_name: myoxus
     metrics_path: /metrics/prometheus
     static_configs: [{ targets: ["myoxus-api:3001"] }]
   ```
2. Copy `prometheus/alerts.yaml` into `rule_files:` and reload Prometheus.
   Validate first — either via a local `promtool` install
   (`promtool check rules prometheus/alerts.yaml`) or the Docker-based wrapper
   `build/scripts/server/smoke-prometheus-rules.sh` which runs `promtool`
   through the official `prom/prometheus` image.
3. Import Grafana dashboards from `grafana/*.json` (one at a time via
   **Dashboards → Import**), picking your Prometheus data source.

## Related

- [`../metrics.md`](../metrics.md) — business-metrics runbook (scrape config, dashboard import, alert deployment, retention, privacy)
- [`../telemetry.md`](../telemetry.md) — telemetry pipeline runbook
- [Runbooks](../../runbooks/README.md) — incident recovery procedures
