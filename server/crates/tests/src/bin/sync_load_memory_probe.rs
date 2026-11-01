// SPDX-License-Identifier: AGPL-3.0-or-later

use std::time::{Duration, Instant};

use myoxus_tests::sync_incident_fixture::SyncIncidentFixture;

const RSS_BUDGET_KIB: u64 = 256 * 1024;

fn linux_rss_kib(field: &str) -> Result<u64, String> {
  let status = std::fs::read_to_string("/proc/self/status")
    .map_err(|error| format!("failed to read /proc/self/status: {error}"))?;
  let value = status
    .lines()
    .find_map(|line| line.strip_prefix(field))
    .ok_or_else(|| format!("missing {field} in /proc/self/status"))?
    .trim()
    .strip_suffix(" kB")
    .ok_or_else(|| format!("unexpected {field} unit in /proc/self/status"))?;
  value
    .trim()
    .parse()
    .map_err(|error| format!("invalid {field} value in /proc/self/status: {error}"))
}

fn main() {
  let baseline_rss_kib = linux_rss_kib("VmRSS:").expect("Linux RSS baseline is available");
  let baseline_peak_rss_kib = linux_rss_kib("VmHWM:").expect("Linux peak RSS baseline is available");
  let fixture = SyncIncidentFixture::generate();
  fixture.assert_contract();
  let client_state = yjs::get_state_vector(&fixture.root_snapshot).expect("fixture snapshot has a state vector");
  let input_bytes = fixture.root_snapshot.len() + fixture.root_tail_updates.iter().map(Vec::len).sum::<usize>();

  println!(
    "baseline rss_kib={} peak_rss_kib={} input_bytes={} update_count={}",
    baseline_rss_kib,
    baseline_peak_rss_kib,
    input_bytes,
    1 + fixture.root_tail_updates.len()
  );
  let mut quiet_rss_kib = Vec::with_capacity(3);
  for run in 1..=3 {
    let started = Instant::now();
    let result = yjs::materialize_diff_v1(
      std::iter::once(&fixture.root_snapshot).chain(fixture.root_tail_updates.iter()),
      Some(&client_state),
      8 * 1024 * 1024,
      || false,
    )
    .expect("incident fixture materializes without fallback");
    assert_eq!(result.input_bytes, input_bytes);
    assert_eq!(result.update_count, 1 + fixture.root_tail_updates.len());
    let output_bytes = result.missing.len() + result.state_vector.len();
    assert!(
      output_bytes < input_bytes,
      "incremental output must remain smaller than the persisted input"
    );
    drop(result);
    std::thread::sleep(Duration::from_millis(100));
    let rss_kib = linux_rss_kib("VmRSS:").expect("Linux RSS sample is available");
    let peak_rss_kib = linux_rss_kib("VmHWM:").expect("Linux peak RSS sample is available");
    assert!(
      peak_rss_kib <= baseline_rss_kib.saturating_add(RSS_BUDGET_KIB),
      "peak RSS exceeded the baseline + 256 MiB budget"
    );
    quiet_rss_kib.push(rss_kib);
    println!(
      "run={} duration_ms={} output_bytes={} rss_kib={} peak_rss_kib={}",
      run,
      started.elapsed().as_millis(),
      output_bytes,
      rss_kib,
      peak_rss_kib
    );
  }
  assert!(
    !quiet_rss_kib.windows(2).all(|window| window[0] < window[1]),
    "quiet RSS grew monotonically across all three identical materializations"
  );
}
