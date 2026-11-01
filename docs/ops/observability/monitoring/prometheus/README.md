# Prometheus alert rules

[Documentation](../../../../README.md) / [Operations](../../../README.md) / [Observability](../../README.md) / [Monitoring](../README.md)

Prometheus alert rule definitions for the Myoxus server.

## Files

| File                           | Contents                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| [`alerts.yaml`](./alerts.yaml) | Invariant alerts for permanent worker failures, cardinality drops, and stalled metric flushes |

## Usage

Add `alerts.yaml` to your Prometheus `rule_files` configuration:

```yaml
rule_files:
  - /etc/prometheus/rules/alerts.yaml
```

The Myoxus API exposes Prometheus text at `GET /metrics/prometheus`.
`GET /metrics` is the JSON operational snapshot. The bundled rules deliberately
avoid workload-specific latency, error-rate, queue-depth, authentication, and
CAPTCHA thresholds; define those from measured operator policy.

## Related

- [Grafana dashboards](../grafana/README.md)
- [Runbooks](../../../runbooks/README.md) — incident response for triggered alerts
