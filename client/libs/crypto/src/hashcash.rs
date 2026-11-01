// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Clean-room Hashcash implementation (AGPL-3.0-or-later).
// Based on the public Hashcash specification by Adam Back (2002).
// Uses SHA3-256 (FIPS 202) instead of the original SHA-1.
//
// Stamp format: ver:bits:date:resource:ext:rand:counter
// - ver = 1
// - bits = difficulty (number of leading zero bits required in hash)
// - date = YYMMDD
// - resource = the thing being stamped (e.g., email, challenge token)
// - ext = extension field (empty for basic stamps)
// - rand = random base64 string
// - counter = incrementing counter in base64
//
// Minting: increment counter until SHA3-256(stamp_string) has >= `bits` leading zero bits.
// Verification: compute SHA3-256(stamp_string) and check leading zero bits >= claimed bits.

use sha3::{Digest, Sha3_256};

/// A Hashcash stamp (SHA3-256 variant).
#[derive(Debug, Clone)]
pub struct Stamp {
  pub ver: u32,
  pub bits: u32,
  pub date: String,
  pub resource: String,
  pub ext: String,
  pub rand: String,
  pub counter: String,
}

/// Default difficulty when none is specified.
const DEFAULT_BITS: u32 = 20;

/// Count the number of leading zero bits in a byte slice.
fn leading_zero_bits(hash: &[u8]) -> u32 {
  let mut count = 0u32;
  for &byte in hash {
    if byte == 0 {
      count += 8;
    } else {
      count += byte.leading_zeros();
      break;
    }
  }
  count
}

/// Encode an integer as a base64-like string (alphanumeric + '+/').
/// Uses a simple mapping for compact counter representation.
fn encode_counter(mut n: u64) -> String {
  const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if n == 0 {
    return "A".to_string();
  }
  let mut result = Vec::new();
  while n > 0 {
    result.push(CHARS[(n % 64) as usize]);
    n /= 64;
  }
  result.reverse();
  String::from_utf8(result).unwrap()
}

/// Generate a random base64 string of given byte length.
fn random_base64(len: usize) -> String {
  use std::collections::hash_map::RandomState;
  use std::hash::{BuildHasher, Hasher};

  const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut result = Vec::with_capacity(len);
  // Use RandomState for seeding, then generate pseudo-random bytes.
  let state = RandomState::new();
  let mut h = state.build_hasher();
  for i in 0..len {
    h.write_usize(i);
    let val = h.finish();
    result.push(CHARS[(val % 64) as usize]);
    // Re-seed hasher with previous output for next iteration
    h = state.build_hasher();
    h.write_u64(val);
  }
  String::from_utf8(result).unwrap()
}

/// Get the current date as YYMMDD string.
fn current_date_stamp() -> String {
  // Use chrono if available, otherwise fall back to a simple approach.
  // Since chrono is a workspace dep, we use a manual approach to avoid adding it here.
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap()
    .as_secs();
  // Convert unix timestamp to YYMMDD
  // Days since epoch
  let days = now / 86400;
  // Approximate year/month/day calculation
  let (year, month, day) = days_to_ymd(days);
  format!("{:02}{:02}{:02}", year % 100, month, day)
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
  // Algorithm from Howard Hinnant's date algorithms
  let z = days + 719468;
  let era = z / 146097;
  let doe = z - era * 146097;
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  let y = if m <= 2 { y + 1 } else { y };
  (y, m, d)
}

impl Stamp {
  /// Mint a new Hashcash stamp for the given resource.
  ///
  /// `bits` specifies the difficulty (number of leading zero bits required).
  /// If `None`, defaults to 20.
  pub fn mint(resource: String, bits: Option<u32>) -> Self {
    let bits = bits.unwrap_or(DEFAULT_BITS);
    let date = current_date_stamp();
    let rand = random_base64(16);

    let prefix = format!("1:{bits}:{date}:{resource}::{rand}:");

    let mut counter: u64 = 0;
    loop {
      let counter_str = encode_counter(counter);
      let stamp_str = format!("{prefix}{counter_str}");

      let hash = Sha3_256::digest(stamp_str.as_bytes());
      if leading_zero_bits(&hash) >= bits {
        return Stamp {
          ver: 1,
          bits,
          date,
          resource,
          ext: String::new(),
          rand,
          counter: counter_str,
        };
      }
      counter += 1;
    }
  }

  /// Format this stamp as the canonical stamp string.
  pub fn format(&self) -> String {
    format!(
      "{}:{}:{}:{}:{}:{}:{}",
      self.ver, self.bits, self.date, self.resource, self.ext, self.rand, self.counter
    )
  }

  /// Check that this stamp is valid for the given difficulty and resource.
  pub fn check(&self, bits: u32, resource: &str) -> bool {
    if self.resource != resource {
      return false;
    }
    if self.bits < bits {
      return false;
    }
    let stamp_str = self.format();
    let hash = Sha3_256::digest(stamp_str.as_bytes());
    leading_zero_bits(&hash) >= bits
  }
}

impl std::convert::TryFrom<&str> for Stamp {
  type Error = StampParseError;

  fn try_from(s: &str) -> std::result::Result<Self, Self::Error> {
    let parts: Vec<&str> = s.splitn(7, ':').collect();
    if parts.len() != 7 {
      return Err(StampParseError::InvalidFormat);
    }

    let ver: u32 = parts[0].parse().map_err(|_| StampParseError::InvalidVersion)?;
    if ver != 1 {
      return Err(StampParseError::InvalidVersion);
    }

    let bits: u32 = parts[1].parse().map_err(|_| StampParseError::InvalidBits)?;

    Ok(Stamp {
      ver,
      bits,
      date: parts[2].to_string(),
      resource: parts[3].to_string(),
      ext: parts[4].to_string(),
      rand: parts[5].to_string(),
      counter: parts[6].to_string(),
    })
  }
}

/// Errors that can occur when parsing a stamp string.
#[derive(Debug, Clone)]
pub enum StampParseError {
  InvalidFormat,
  InvalidVersion,
  InvalidBits,
}

impl std::fmt::Display for StampParseError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      StampParseError::InvalidFormat => write!(f, "invalid stamp format"),
      StampParseError::InvalidVersion => write!(f, "invalid stamp version"),
      StampParseError::InvalidBits => write!(f, "invalid stamp bits"),
    }
  }
}

impl std::error::Error for StampParseError {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn mint_produces_valid_stamp() {
    let stamp = Stamp::mint("test@example.com".to_string(), Some(8));
    let stamp_str = stamp.format();

    // Verify format: 7 colon-separated fields
    assert_eq!(stamp_str.split(':').count(), 7);
    assert!(stamp_str.starts_with("1:8:"));

    // Verify the hash has enough leading zero bits
    let hash = Sha3_256::digest(stamp_str.as_bytes());
    assert!(leading_zero_bits(&hash) >= 8);
  }

  #[test]
  fn verify_accepts_valid_stamp() {
    let stamp = Stamp::mint("challenge-token".to_string(), Some(8));
    assert!(stamp.check(8, "challenge-token"));
  }

  #[test]
  fn verify_rejects_wrong_resource() {
    let stamp = Stamp::mint("correct-resource".to_string(), Some(8));
    assert!(!stamp.check(8, "wrong-resource"));
  }

  #[test]
  fn verify_rejects_higher_difficulty() {
    // Mint with 8 bits, then check with 128 — should fail
    // (astronomically unlikely to accidentally have 128 leading zeros)
    let stamp = Stamp::mint("resource".to_string(), Some(8));
    assert!(!stamp.check(128, "resource"));
  }

  #[test]
  fn roundtrip_parse_and_check() {
    let stamp = Stamp::mint("roundtrip@test".to_string(), Some(10));
    let stamp_str = stamp.format();

    let parsed = Stamp::try_from(stamp_str.as_str()).unwrap();
    assert!(parsed.check(10, "roundtrip@test"));
    assert_eq!(parsed.ver, 1);
    assert_eq!(parsed.bits, 10);
    assert_eq!(parsed.resource, "roundtrip@test");
  }

  #[test]
  fn parse_rejects_invalid_format() {
    assert!(Stamp::try_from("not:enough:fields").is_err());
    assert!(Stamp::try_from("2:8:260325:res::rand:counter").is_err()); // wrong version
    assert!(Stamp::try_from("1:abc:260325:res::rand:counter").is_err()); // non-numeric bits
  }

  #[test]
  fn leading_zero_bits_counts_correctly() {
    assert_eq!(leading_zero_bits(&[0x00, 0x00, 0xFF]), 16);
    assert_eq!(leading_zero_bits(&[0x00, 0x80, 0xFF]), 8);
    assert_eq!(leading_zero_bits(&[0x0F, 0xFF]), 4);
    assert_eq!(leading_zero_bits(&[0xFF]), 0);
    assert_eq!(leading_zero_bits(&[0x01]), 7);
    assert_eq!(leading_zero_bits(&[]), 0);
  }

  #[test]
  fn default_difficulty_constant_is_20() {
    // Verify the constant without actually mining at difficulty 20
    // (which would take too long for a unit test).
    assert_eq!(DEFAULT_BITS, 20);
  }

  #[test]
  fn encode_counter_produces_valid_output() {
    assert_eq!(encode_counter(0), "A");
    let s = encode_counter(12345);
    assert!(!s.is_empty());
    // All characters should be in the base64 alphabet
    for c in s.chars() {
      assert!(
        c.is_ascii_alphanumeric() || c == '+' || c == '/',
        "unexpected char: {c}"
      );
    }
  }
}
