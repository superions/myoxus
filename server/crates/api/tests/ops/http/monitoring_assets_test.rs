//! Integration tests for monitoring asset delivery (Prometheus scrape config, Grafana dashboards).
use std::fs;

#[test]
fn monitoring_assets_cover_storage_notifications_search_and_worker() {
  let dashboard_path = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../ops/monitoring/grafana/p4-observability-dashboard.json"
  );
  let alerts_path = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../ops/monitoring/prometheus/p4-alerts.yaml"
  );

  let dashboard_raw = fs::read_to_string(dashboard_path).expect("dashboard json exists");
  let dashboard: serde_json::Value = serde_json::from_str(&dashboard_raw).expect("valid dashboard json");
  let panels = dashboard["panels"].as_array().expect("panels array");
  assert!(panels.iter().any(|p| p["title"] == "Storage Route Errors"));
  assert!(panels.iter().any(|p| p["title"] == "Notifications Queue Pressure"));
  assert!(panels.iter().any(|p| p["title"] == "Search Queue Pressure"));
  assert!(panels.iter().any(|p| p["title"] == "Worker Queue Lag (s)"));

  let alerts_raw = fs::read_to_string(alerts_path).expect("alerts yaml exists");
  let alerts: yaml_serde::Value = yaml_serde::from_str(&alerts_raw).expect("valid alerts yaml");
  let rules = alerts["groups"][0]["rules"].as_sequence().expect("rules sequence");
  assert!(rules.iter().any(|r| r["alert"] == "MyoxusHighErrorRate"));
  assert!(rules.iter().any(|r| r["alert"] == "MyoxusWorkerQueueLagSearch"));
  assert!(
    rules
      .iter()
      .any(|r| r["alert"] == "MyoxusWorkerQueueLagCalendarReminder")
  );
  assert!(rules.iter().any(|r| r["alert"] == "MyoxusDeadLetterGrowth"));
}
