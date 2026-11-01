// SPDX-License-Identifier: AGPL-3.0-or-later
//! P96-LOG-C04 — Integration test: tail_handler rotation survival.
//!
//! Invariant: the tail logic (`find_current_log_file` + `tail_lines`) continues
//! delivering log lines from a NEW log file after log rotation, i.e. when the
//! previous current file is renamed and a new file with the same stem is created.
//!
//! This tests the complete rotation-detection cycle that the async SSE stream
//! in `tail_handler` relies on:
//!   1. Read lines from file A (before rotation).
//!   2. File A is renamed (rotation).
//!   3. New file A is created with fresh lines.
//!   4. `find_current_log_file` switches to the new file by mtime.
//!   5. `tail_lines` reads the new file successfully.

use myoxus_api::handlers::logs::{collect_log_files, find_current_log_file, tail_lines};
use std::fs;
use std::time::{Duration, SystemTime};

/// Write content to a file, set explicit mtime, return path.
fn write_with_mtime(dir: &std::path::Path, name: &str, content: &str, mtime: SystemTime) -> std::path::PathBuf {
  let path = dir.join(name);
  fs::write(&path, content).expect("write log file");
  fs::File::options()
    .write(true)
    .open(&path)
    .unwrap()
    .set_modified(mtime)
    .expect("set mtime");
  path
}

/// P96-LOG-C04a: tail_lines reads lines from the initial file before rotation.
#[test]
fn inv_log_c04a_tail_reads_initial_lines() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c04a-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let content = "line-before-rotation-1\nline-before-rotation-2\nline-before-rotation-3\n";
  let base_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  write_with_mtime(&dir, "myoxus.log", content, base_time);

  let (lines, pos) = tail_lines(&dir.join("myoxus.log"), 50).expect("tail_lines");
  assert_eq!(lines.len(), 3, "must read 3 lines from initial file");
  assert_eq!(lines[0], "line-before-rotation-1");
  assert_eq!(lines[2], "line-before-rotation-3");
  assert!(pos > 0, "position must be non-zero after reading content");

  fs::remove_dir_all(&dir).ok();
}

/// P96-LOG-C04b: After rotation, find_current_log_file switches to the new file.
///
/// Rotation: rename myoxus.log → myoxus.2026-03-31.log (older mtime),
/// create new myoxus.log (newer mtime).
/// `find_current_log_file` must return the new myoxus.log.
#[test]
fn inv_log_c04b_rotation_detection_switches_to_new_file() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c04b-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let base_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  let rotated_time = base_time; // old file: older mtime
  let new_time = base_time + Duration::from_secs(3600); // new file: newer mtime

  // Before rotation: myoxus.log is current
  write_with_mtime(&dir, "myoxus.log", "old-line-1\n", base_time);
  let found_before = find_current_log_file(&dir, "myoxus").expect("must find file before rotation");
  assert_eq!(
    found_before.file_name().and_then(|n| n.to_str()),
    Some("myoxus.log"),
    "before rotation: current file must be myoxus.log"
  );

  // Simulate rotation: rename myoxus.log → myoxus.2026-03-31.log
  let rotated_path = dir.join("myoxus.2026-03-31.log");
  fs::rename(dir.join("myoxus.log"), &rotated_path).expect("rename log file");
  fs::File::options()
    .write(true)
    .open(&rotated_path)
    .unwrap()
    .set_modified(rotated_time)
    .expect("set rotated mtime");

  // Create new log file (newer mtime)
  write_with_mtime(
    &dir,
    "myoxus.log",
    "new-line-after-rotation-1\nnew-line-after-rotation-2\n",
    new_time,
  );

  // After rotation: find_current_log_file must return the NEW myoxus.log (newest mtime)
  let found_after = find_current_log_file(&dir, "myoxus").expect("must find file after rotation");
  assert_eq!(
    found_after.file_name().and_then(|n| n.to_str()),
    Some("myoxus.log"),
    "after rotation: current file must be the new myoxus.log (newest mtime)"
  );

  // Verify new file contains the new lines
  let (new_lines, _) = tail_lines(&found_after, 10).expect("tail_lines on new file");
  assert_eq!(new_lines.len(), 2, "new file must have 2 lines after rotation");
  assert_eq!(new_lines[0], "new-line-after-rotation-1");
  assert_eq!(new_lines[1], "new-line-after-rotation-2");

  fs::remove_dir_all(&dir).ok();
}

/// P96-LOG-C04c: collect_log_files returns both old (rotated) and new log files.
///
/// After rotation, both the renamed file and the new file must be collected.
/// This is the invariant relied on by the download endpoint.
#[test]
fn inv_log_c04c_both_files_collected_after_rotation() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c04c-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let base_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  write_with_mtime(&dir, "myoxus.2026-03-31.log", "old-line\n", base_time);
  write_with_mtime(&dir, "myoxus.log", "new-line\n", base_time + Duration::from_secs(3600));

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files");
  let names: Vec<&str> = files.iter().filter_map(|p| p.file_name()?.to_str()).collect();

  assert_eq!(names.len(), 2, "must collect both rotated and new log file");
  assert!(names.contains(&"myoxus.log"), "new log file must be collected");
  assert!(
    names.contains(&"myoxus.2026-03-31.log"),
    "rotated log file must be collected"
  );

  fs::remove_dir_all(&dir).ok();
}

/// P96-LOG-C04d: After rotation, tail_lines on the new file reads only new content.
///
/// This verifies the SSE stream position-tracking invariant: when switching to the
/// new file, the stream starts reading from byte 0 (not carrying over the old
/// file's position), so no lines are skipped.
#[test]
fn inv_log_c04d_new_file_read_from_zero() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c04d-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let base_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  let new_time = base_time + Duration::from_secs(3600);

  // Write a large-ish file as "old" log
  let old_content = "a".repeat(100) + "\n" + &"b".repeat(100) + "\n";
  let old_pos_after_reading = old_content.len() as u64;
  write_with_mtime(&dir, "myoxus.2026-03-31.log", &old_content, base_time);

  // New file after rotation: has fresh short content
  let new_content = "first-new-line\nsecond-new-line\n";
  write_with_mtime(&dir, "myoxus.log", new_content, new_time);

  // tail_lines on the new file starting from position 0 must read all lines
  let (lines, pos) = tail_lines(&dir.join("myoxus.log"), 50).expect("tail_lines on new file");
  assert_eq!(lines.len(), 2, "new file must yield 2 lines when read from zero");
  assert_eq!(lines[0], "first-new-line");
  assert_eq!(lines[1], "second-new-line");
  assert!(
    pos < old_pos_after_reading,
    "new file position {pos} must be less than old file length {old_pos_after_reading} (new file is shorter)"
  );

  fs::remove_dir_all(&dir).ok();
}
