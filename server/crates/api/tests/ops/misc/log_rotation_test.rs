//! Unit tests for P96-LOG-B01 and P96-LOG-B02 improvements to the log file handler.
//! Extended by P97-B-06, P97-B-07, and P96-LOG-C03.
//!
//! C01: collect_log_files stem-filter invariant
//! C02: find_current_log_file picks the newest file by mtime
//! P97-B-06a: three rotated files all collected, newest found
//! P97-B-06b: non-rotated myoxus.log only → found as current
//! P97-B-06c: old-format files (no .log extension) excluded
//! P97-B-06d: empty dir → find_current_log_file returns None
//! P97-B-07:  collect_log_files returns sorted list for pruning decisions
//! P96-LOG-C03: RollingFileAppender::builder max_log_files(3) prunes to ≤3 files on disk

use myoxus_api::handlers::logs::{collect_log_files, find_current_log_file};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tracing_appender::rolling;

fn touch(dir: &Path, name: &str) -> PathBuf {
  let p = dir.join(name);
  fs::write(&p, b"").expect("write test file");
  p
}

/// C01: collect_log_files with stem="myoxus" must include only files that both
/// start with "myoxus" AND end with ".log".
#[test]
fn test_log_filename_format() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c01-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  // Files that MUST be included
  touch(&dir, "myoxus.2026-03-30.log");
  touch(&dir, "myoxus.2026-03-29.log");
  touch(&dir, "myoxus.log");
  // Files that MUST be excluded
  touch(&dir, "other.txt");
  touch(&dir, "myoxus.log.2026-03-28"); // old-format: wrong extension
  touch(&dir, "other.2026-03-30.log"); // wrong stem

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files");
  let names: Vec<&str> = files.iter().filter_map(|p| p.file_name()?.to_str()).collect();

  assert!(
    names.contains(&"myoxus.2026-03-30.log"),
    "must include myoxus.2026-03-30.log"
  );
  assert!(
    names.contains(&"myoxus.2026-03-29.log"),
    "must include myoxus.2026-03-29.log"
  );
  assert!(names.contains(&"myoxus.log"), "must include myoxus.log");
  assert!(!names.contains(&"other.txt"), "must exclude other.txt");
  assert!(
    !names.contains(&"myoxus.log.2026-03-28"),
    "must exclude old-format file"
  );
  assert!(!names.contains(&"other.2026-03-30.log"), "must exclude wrong-stem file");
  assert_eq!(names.len(), 3, "exactly 3 files must be collected");

  fs::remove_dir_all(&dir).ok();
}

/// C02: find_current_log_file returns the file with the most recent mtime.
#[test]
fn test_find_current_log_file_returns_newest() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c02-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let old = touch(&dir, "myoxus.2026-03-28.log");
  let mid = touch(&dir, "myoxus.2026-03-29.log");
  let newest = touch(&dir, "myoxus.2026-03-30.log");

  // Set mtimes explicitly: old < mid < newest using std::fs::File::set_modified (stable since 1.75)
  let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  fs::File::options()
    .write(true)
    .open(&old)
    .unwrap()
    .set_modified(base)
    .expect("set mtime old");
  fs::File::options()
    .write(true)
    .open(&mid)
    .unwrap()
    .set_modified(base + Duration::from_secs(3600))
    .expect("set mtime mid");
  fs::File::options()
    .write(true)
    .open(&newest)
    .unwrap()
    .set_modified(base + Duration::from_secs(7200))
    .expect("set mtime newest");

  let found = find_current_log_file(&dir, "myoxus").expect("find_current_log_file");
  assert_eq!(
    found.file_name().and_then(|n| n.to_str()),
    Some("myoxus.2026-03-30.log"),
    "must return the newest file by mtime"
  );

  fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// P97-B-06: filename-format tests for the new RollingFileAppender layout
// ---------------------------------------------------------------------------

/// P97-B-06a: Three rotated files — all collected, sorted, newest returned by find_current.
#[test]
fn test_log_collect_new_format() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-b06a-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let f28 = touch(&dir, "myoxus.2026-03-28.log");
  let f29 = touch(&dir, "myoxus.2026-03-29.log");
  let f30 = touch(&dir, "myoxus.2026-03-30.log");

  let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  fs::File::options()
    .write(true)
    .open(&f28)
    .unwrap()
    .set_modified(base)
    .unwrap();
  fs::File::options()
    .write(true)
    .open(&f29)
    .unwrap()
    .set_modified(base + Duration::from_secs(86400))
    .unwrap();
  fs::File::options()
    .write(true)
    .open(&f30)
    .unwrap()
    .set_modified(base + Duration::from_secs(172800))
    .unwrap();

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files");
  assert_eq!(files.len(), 3, "all 3 rotated files must be collected");
  // collect_log_files sorts alphabetically; verify order
  let names: Vec<&str> = files.iter().filter_map(|p| p.file_name()?.to_str()).collect();
  assert_eq!(names[0], "myoxus.2026-03-28.log");
  assert_eq!(names[2], "myoxus.2026-03-30.log");

  let current = find_current_log_file(&dir, "myoxus").expect("must find current");
  assert_eq!(
    current.file_name().and_then(|n| n.to_str()),
    Some("myoxus.2026-03-30.log")
  );

  fs::remove_dir_all(&dir).ok();
}

/// P97-B-06b: Only myoxus.log (no rotation) — found as the current file.
#[test]
fn test_log_current_file_plain_log() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-b06b-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  touch(&dir, "myoxus.log");

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files");
  assert_eq!(files.len(), 1, "plain myoxus.log must be collected");

  let current = find_current_log_file(&dir, "myoxus").expect("must find current");
  assert_eq!(current.file_name().and_then(|n| n.to_str()), Some("myoxus.log"));

  fs::remove_dir_all(&dir).ok();
}

/// P97-B-06c: Old-format files (myoxus.log.YYYY-MM-DD, no .log extension) must be excluded.
#[test]
fn test_log_old_format_excluded() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-b06c-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  touch(&dir, "myoxus.log.2026-03-28"); // old logrotate-style: must be excluded
  touch(&dir, "myoxus.2026-03-29.log"); // new format: must be included

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files");
  let names: Vec<&str> = files.iter().filter_map(|p| p.file_name()?.to_str()).collect();
  assert_eq!(names.len(), 1, "only new-format file must be collected");
  assert_eq!(names[0], "myoxus.2026-03-29.log");

  fs::remove_dir_all(&dir).ok();
}

/// P97-B-06d: Empty directory — find_current_log_file must return None without panic.
#[test]
fn test_log_empty_dir_returns_none() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-b06d-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files on empty dir");
  assert!(files.is_empty(), "empty dir must yield no files");

  let current = find_current_log_file(&dir, "myoxus");
  assert!(
    current.is_none(),
    "empty dir must yield None from find_current_log_file"
  );

  fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// P97-B-07: collect_log_files returns correctly sorted list for pruning
// ---------------------------------------------------------------------------

/// P97-B-07: Five rotated log files sorted alphabetically — caller can prune
/// by keeping the last N entries, matching max_log_files(N) semantics.
#[test]
fn test_log_collect_sorted_for_pruning() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-b07-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  for day in 26..=30u32 {
    touch(&dir, &format!("myoxus.2026-03-{day:02}.log"));
  }

  let files = collect_log_files(&dir, "myoxus").expect("collect_log_files");
  assert_eq!(files.len(), 5, "all 5 files collected");

  let names: Vec<&str> = files.iter().filter_map(|p| p.file_name()?.to_str()).collect();
  // Alphabetical sort places older dates first — pruning keeps last N (newest)
  assert_eq!(names[0], "myoxus.2026-03-26.log", "oldest first");
  assert_eq!(names[4], "myoxus.2026-03-30.log", "newest last");

  // Simulate max_log_files(3): keep last 3 entries
  let keep = &names[names.len() - 3..];
  assert_eq!(keep.len(), 3);
  assert_eq!(keep[0], "myoxus.2026-03-28.log");
  assert_eq!(keep[2], "myoxus.2026-03-30.log");

  fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// P96-LOG-C03: RollingFileAppender::builder max_log_files pruning
// ---------------------------------------------------------------------------

/// P96-LOG-C03: When RollingFileAppender is built with max_log_files(3) and
/// 5 pre-existing daily log files, `build()` must prune so that at most 3
/// files remain on disk (the 2 newest pre-existing + the newly created one).
///
/// Invariant: disk file count after build() ≤ max_log_files.
#[test]
fn inv_log_max_files_pruning() {
  let dir = std::env::temp_dir().join(format!("myoxus-log-c03-{}", std::process::id()));
  fs::create_dir_all(&dir).expect("create temp dir");

  // Create 5 correctly named daily log files with increasing mtime.
  let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
  for (i, day) in (26u32..=30).enumerate() {
    let name = format!("myoxus.2026-03-{day:02}.log");
    let path = dir.join(&name);
    fs::write(&path, b"").expect("write log file");
    fs::File::options()
      .write(true)
      .open(&path)
      .unwrap()
      .set_modified(base + Duration::from_secs(i as u64 * 86400))
      .expect("set mtime");
  }

  // Build the appender with max_log_files(3): appender prunes on construction.
  let _appender = rolling::RollingFileAppender::builder()
    .rotation(rolling::Rotation::DAILY)
    .filename_prefix("myoxus")
    .filename_suffix("log")
    .max_log_files(3)
    .build(&dir)
    .expect("build rolling file appender");

  // Count myoxus*.log files remaining after pruning + new file creation.
  let remaining = fs::read_dir(&dir)
    .expect("read dir")
    .filter_map(Result::ok)
    .filter(|e| {
      let name = e.file_name();
      let s = name.to_string_lossy();
      s.starts_with("myoxus") && s.ends_with(".log")
    })
    .count();

  assert!(
    remaining <= 3,
    "P96-LOG-C03: after build() with max_log_files(3) and 5 pre-existing files, \
     at most 3 must remain on disk; got {remaining}"
  );

  fs::remove_dir_all(&dir).ok();
}
