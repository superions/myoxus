// SPDX-License-Identifier: AGPL-3.0-or-later
//! Cross-platform disk space monitoring.
//!
//! Provides filesystem-level disk usage information for any directory.
//! Used by Git Sync (mirror storage), Logging (log rotation), and the
//! admin dashboard (storage overview).
//!
//! Uses `libc::statvfs` on Unix for reliable, zero-overhead filesystem stats.

use std::path::Path;

use tracing::{debug, info, instrument, warn};

/// Disk usage summary for a monitored directory.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DiskUsage {
  /// Total size of all files in the directory tree, in bytes.
  pub total_bytes: u64,
  /// Number of immediate subdirectories (e.g. repo clones, log rotations).
  pub entry_count: u64,
  /// Available (non-root) free space on the filesystem, in bytes.
  pub free_bytes: u64,
  /// Total capacity of the filesystem, in bytes.
  pub capacity_bytes: u64,
  /// Configured limit in bytes (0 = unlimited). Application-level, not filesystem.
  pub limit_bytes: u64,
}

impl DiskUsage {
  /// Usage as percentage of the configured limit (0.0–100.0).
  /// Returns 0.0 if limit is 0 (unlimited).
  pub fn usage_percent(&self) -> f64 {
    if self.limit_bytes == 0 {
      return 0.0;
    }
    (self.total_bytes as f64 / self.limit_bytes as f64) * 100.0
  }

  /// Usage as percentage of filesystem capacity.
  pub fn filesystem_usage_percent(&self) -> f64 {
    if self.capacity_bytes == 0 {
      return 0.0;
    }
    let used = self.capacity_bytes.saturating_sub(self.free_bytes);
    (used as f64 / self.capacity_bytes as f64) * 100.0
  }
}

/// Calculate total size of all files under a directory, recursively.
///
/// Runs in a blocking thread to avoid starving the async runtime.
/// Returns 0 if the directory doesn't exist.
#[instrument(skip_all)]
pub async fn dir_size_bytes(path: &Path) -> u64 {
  if !path.exists() {
    return 0;
  }
  let path = path.to_path_buf();
  tokio::task::spawn_blocking(move || dir_size_sync(&path))
    .await
    .unwrap_or(0)
}

fn dir_size_sync(path: &Path) -> u64 {
  let mut total = 0u64;
  let entries = match std::fs::read_dir(path) {
    Ok(e) => e,
    Err(_) => return 0,
  };
  for entry in entries.flatten() {
    // Use file_type() (lstat) instead of metadata() (stat) to avoid
    // following symlinks. A symlink to a large directory outside our
    // managed scope would inflate the reported size incorrectly.
    let ft = match entry.file_type() {
      Ok(ft) => ft,
      Err(_) => continue,
    };
    if ft.is_symlink() {
      continue; // skip symlinks — only count real files we manage
    }
    if ft.is_dir() {
      total += dir_size_sync(&entry.path());
    } else {
      // For regular files, metadata().len() is safe (no symlink follow)
      let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
      total += size;
    }
  }
  total
}

/// Count immediate subdirectories under a path.
#[instrument(skip_all)]
pub async fn subdir_count(path: &Path) -> u64 {
  if !path.exists() {
    return 0;
  }
  let path = path.to_path_buf();
  tokio::task::spawn_blocking(move || {
    std::fs::read_dir(&path)
      .map(|entries| {
        entries
          .flatten()
          .filter(|e| e.metadata().map(|m| m.is_dir()).unwrap_or(false))
          .count() as u64
      })
      .unwrap_or(0)
  })
  .await
  .unwrap_or(0)
}

/// Filesystem stats for a path: free bytes and total capacity.
///
/// Uses `libc::statvfs` on Unix for accurate results without spawning processes.
/// Returns `(free_bytes, capacity_bytes)`. Both 0 on error.
pub fn filesystem_stats(path: &Path) -> (u64, u64) {
  let target = if path.exists() {
    path
  } else {
    // If path doesn't exist, check parent
    match path.parent() {
      Some(p) if p.exists() => p,
      _ => Path::new("/"),
    }
  };

  #[cfg(unix)]
  {
    let c_path = match std::ffi::CString::new(target.to_string_lossy().as_bytes()) {
      Ok(p) => p,
      Err(_) => return (0, 0),
    };
    unsafe {
      let mut stat: libc::statvfs = std::mem::zeroed();
      if libc::statvfs(c_path.as_ptr(), &mut stat) == 0 {
        let free = stat.f_bavail as u64 * stat.f_frsize as u64;
        let total = stat.f_blocks as u64 * stat.f_frsize as u64;
        return (free, total);
      }
    }
    (0, 0)
  }

  #[cfg(not(unix))]
  {
    let _ = target;
    (0, 0)
  }
}

/// Pre-flight disk check before a space-consuming operation.
///
/// Checks two conditions:
/// 1. Total directory size is below the configured limit (if limit > 0).
/// 2. Free filesystem space is above the configured minimum (if min > 0).
///
/// Returns `Ok(())` if both checks pass, `Err(message)` if either fails.
#[instrument(skip_all)]
pub async fn preflight_check(dir: &Path, max_storage_mb: u64, min_free_disk_mb: u64) -> Result<(), String> {
  // Check 1: Application-level storage limit
  if max_storage_mb > 0 {
    let total = dir_size_bytes(dir).await;
    let limit = max_storage_mb * 1024 * 1024;
    if total >= limit {
      let total_mb = total / (1024 * 1024);
      return Err(format!(
        "storage limit exceeded: {total_mb} MB used, limit is {max_storage_mb} MB"
      ));
    }
    let usage_pct = (total * 100) / limit.max(1);
    if usage_pct >= 80 {
      warn!(
        total_mb = total / (1024 * 1024),
        limit_mb = max_storage_mb,
        usage_pct,
        "storage at {usage_pct}% of configured limit"
      );
    }
  }

  // Check 2: Filesystem free space
  if min_free_disk_mb > 0 {
    let (free, _) = filesystem_stats(dir);
    let min_free = min_free_disk_mb * 1024 * 1024;
    if free > 0 && free < min_free {
      let free_mb = free / (1024 * 1024);
      return Err(format!(
        "insufficient free disk space: {free_mb} MB free, minimum required is {min_free_disk_mb} MB"
      ));
    }
    if free > 0 && free < min_free * 2 {
      let free_mb = free / (1024 * 1024);
      warn!(free_mb, min_free_mb = min_free_disk_mb, "free disk space is low");
    }
  }

  debug!(
    dir = %dir.display(),
    max_mb = max_storage_mb,
    min_free_mb = min_free_disk_mb,
    "disk preflight check passed"
  );
  Ok(())
}

/// Materialization preflight for an operation that may publish a new durable
/// mirror. In addition to the shared limits, publication requires readable
/// filesystem capacity; an unknown `(0, 0)` result cannot authorize a clone.
pub async fn materialization_preflight_check(
  dir: &Path,
  max_storage_mb: u64,
  min_free_disk_mb: u64,
) -> Result<(), String> {
  preflight_check(dir, max_storage_mb, min_free_disk_mb).await?;
  let (free_bytes, capacity_bytes) = filesystem_stats(dir);
  if free_bytes == 0 || capacity_bytes == 0 {
    return Err("filesystem capacity is unavailable; mirror materialization fails closed".to_string());
  }
  Ok(())
}

/// Compute full disk usage summary for a directory.
#[instrument(skip_all)]
pub async fn compute_usage(dir: &Path, limit_mb: u64) -> DiskUsage {
  let total = dir_size_bytes(dir).await;
  let count = subdir_count(dir).await;
  let (free, capacity) = filesystem_stats(dir);
  let limit = limit_mb * 1024 * 1024;

  info!(
    dir = %dir.display(),
    total_mb = total / (1024 * 1024),
    entries = count,
    free_mb = free / (1024 * 1024),
    capacity_mb = capacity / (1024 * 1024),
    limit_mb,
    "disk usage computed"
  );

  DiskUsage {
    total_bytes: total,
    entry_count: count,
    free_bytes: free,
    capacity_bytes: capacity,
    limit_bytes: limit,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  #[tokio::test]
  async fn dir_size_counts_file_bytes() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("a.txt"), "hello").unwrap();
    std::fs::write(tmp.path().join("b.txt"), "world!").unwrap();
    let size = dir_size_bytes(tmp.path()).await;
    assert_eq!(size, 11); // 5 + 6
  }

  #[tokio::test]
  async fn dir_size_recurses_subdirs() {
    let tmp = TempDir::new().unwrap();
    let sub = tmp.path().join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::fs::write(sub.join("nested.txt"), "data").unwrap();
    let size = dir_size_bytes(tmp.path()).await;
    assert_eq!(size, 4);
  }

  #[tokio::test]
  async fn dir_size_nonexistent_returns_zero() {
    let size = dir_size_bytes(Path::new("/nonexistent/path/42")).await;
    assert_eq!(size, 0);
  }

  #[tokio::test]
  async fn subdir_count_counts_only_dirs() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir(tmp.path().join("repo-a")).unwrap();
    std::fs::create_dir(tmp.path().join("repo-b")).unwrap();
    std::fs::write(tmp.path().join("file.txt"), "x").unwrap();
    let count = subdir_count(tmp.path()).await;
    assert_eq!(count, 2);
  }

  #[test]
  fn filesystem_stats_returns_nonzero_on_unix() {
    let (free, capacity) = filesystem_stats(Path::new("/tmp"));
    assert!(free > 0, "free space on /tmp must be > 0");
    assert!(capacity > 0, "capacity of /tmp filesystem must be > 0");
    assert!(capacity >= free, "capacity must be >= free space");
  }

  #[tokio::test]
  async fn preflight_rejects_over_limit() {
    let tmp = TempDir::new().unwrap();
    let data = vec![0u8; 2 * 1024 * 1024]; // 2 MB
    std::fs::write(tmp.path().join("big.bin"), &data).unwrap();
    let result = preflight_check(tmp.path(), 1, 0).await; // limit 1 MB
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("limit exceeded"));
  }

  #[tokio::test]
  async fn preflight_passes_under_limit() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join("small.txt"), "tiny").unwrap();
    let result = preflight_check(tmp.path(), 1024, 0).await;
    assert!(result.is_ok());
  }

  #[tokio::test]
  async fn preflight_unlimited_always_passes() {
    let tmp = TempDir::new().unwrap();
    let data = vec![0u8; 5 * 1024 * 1024]; // 5 MB
    std::fs::write(tmp.path().join("big.bin"), &data).unwrap();
    let result = preflight_check(tmp.path(), 0, 0).await; // 0 = unlimited
    assert!(result.is_ok());
  }

  #[tokio::test]
  async fn compute_usage_returns_valid_summary() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir(tmp.path().join("repo1")).unwrap();
    std::fs::write(tmp.path().join("repo1/file.txt"), "content").unwrap();
    let usage = compute_usage(tmp.path(), 100).await;
    assert_eq!(usage.total_bytes, 7); // "content" = 7 bytes
    assert_eq!(usage.entry_count, 1);
    assert!(usage.free_bytes > 0);
    assert!(usage.capacity_bytes > 0);
    assert_eq!(usage.limit_bytes, 100 * 1024 * 1024);
  }

  #[test]
  fn usage_percent_with_limit() {
    let usage = DiskUsage {
      total_bytes: 500 * 1024 * 1024,
      entry_count: 3,
      free_bytes: 10_000_000_000,
      capacity_bytes: 50_000_000_000,
      limit_bytes: 1024 * 1024 * 1024, // 1 GB
    };
    let pct = usage.usage_percent();
    assert!((pct - 48.8).abs() < 0.5, "~48.8% expected, got {pct}");
  }

  #[test]
  fn usage_percent_unlimited() {
    let usage = DiskUsage {
      total_bytes: 999,
      entry_count: 0,
      free_bytes: 0,
      capacity_bytes: 0,
      limit_bytes: 0,
    };
    assert_eq!(usage.usage_percent(), 0.0);
  }
}
