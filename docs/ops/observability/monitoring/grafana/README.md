# Grafana dashboards

[Documentation](../../../../README.md) / [Operations](../../../README.md) / [Observability](../../README.md) / [Monitoring](../README.md)

Grafana dashboard definitions for Myoxus server observability.

## Files

| File                                                                   | Contents                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`observability-dashboard.json`](./observability-dashboard.json)       | Server observability dashboard: requests, latency, queue state, and database pool |
| [`business-metrics-dashboard.json`](./business-metrics-dashboard.json) | Business-event and metrics-pipeline counters                                      |

## Usage

Import each JSON file into your Grafana instance via **Dashboards → Import**.
Select the Prometheus data source that scrapes the Myoxus endpoint while
importing each dashboard.

## Related

- [Prometheus alerts](../prometheus/README.md)
