// SPDX-License-Identifier: AGPL-3.0-or-later
//! Fractional order keys shared by native server mutations.
//!
//! The integer and fractional grammar mirrors `fractional-indexing@3.2.0`.
//! Product keys add the same `0` separator and 32-character collision suffix
//! as the Web `generateFractionalIndexingKeyBetween` wrapper.

use rand::{Rng, thread_rng};

const BASE_62_DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_SUFFIX_DIGITS: &[u8] = b"123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_SUFFIX_LENGTH: usize = 32;
const FULL_KEY_SUFFIX_LENGTH: usize = RANDOM_SUFFIX_LENGTH + 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderKeyError {
  Invalid,
  InvalidBounds,
  Exhausted,
}

pub fn is_valid_order_key(key: &str) -> bool {
  validate_order_key(key).is_ok()
}

pub fn validate_order_key(key: &str) -> Result<(), OrderKeyError> {
  let bytes = key.as_bytes();
  let Some(&head) = bytes.first() else {
    return Err(OrderKeyError::Invalid);
  };
  let integer_length = integer_length(head).ok_or(OrderKeyError::Invalid)?;
  if bytes.len() < integer_length || bytes.iter().skip(1).any(|byte| digit_index(*byte).is_none()) {
    return Err(OrderKeyError::Invalid);
  }
  if bytes == b"A00000000000000000000000000" {
    return Err(OrderKeyError::Invalid);
  }
  let fractional = &bytes[integer_length..];
  if fractional.last() == Some(&BASE_62_DIGITS[0]) {
    return Err(OrderKeyError::Invalid);
  }
  Ok(())
}

pub fn generate_order_key_between(lower: Option<&str>, upper: Option<&str>) -> Result<String, OrderKeyError> {
  if let Some(lower) = lower {
    validate_order_key(lower)?;
  }
  if let Some(upper) = upper {
    validate_order_key(upper)?;
  }
  if lower.zip(upper).is_some_and(|(lower, upper)| lower >= upper) {
    return Err(OrderKeyError::InvalidBounds);
  }

  let lower_base = lower.map(wrapper_subkey);
  let upper_base = upper.map(wrapper_subkey);
  let base = match (lower_base, upper_base) {
    (None, None) => generate_base_key_between(None, None)?,
    (None, Some(upper)) => generate_base_key_between(None, Some(upper))?,
    (Some(lower), None) => generate_base_key_between(Some(lower), None)?,
    (Some(lower_base), Some(upper_base)) => {
      let bounds = if (lower_base.starts_with(upper_base) || upper_base.starts_with(lower_base))
        && let (Some(lower), Some(upper)) = (lower, upper)
      {
        (lower, upper)
      } else {
        (lower_base, upper_base)
      };
      generate_base_key_between(Some(bounds.0), Some(bounds.1))?
    }
  };

  let mut rng = thread_rng();
  let mut result = String::with_capacity(base.len() + FULL_KEY_SUFFIX_LENGTH);
  result.push_str(&base);
  result.push('0');
  for _ in 0..RANDOM_SUFFIX_LENGTH {
    let digit = RANDOM_SUFFIX_DIGITS[rng.gen_range(0..RANDOM_SUFFIX_DIGITS.len())];
    result.push(char::from(digit));
  }
  debug_assert!(is_valid_order_key(&result));
  Ok(result)
}

pub fn generate_base_key_between(lower: Option<&str>, upper: Option<&str>) -> Result<String, OrderKeyError> {
  if let Some(lower) = lower {
    validate_order_key(lower)?;
  }
  if let Some(upper) = upper {
    validate_order_key(upper)?;
  }
  if lower.zip(upper).is_some_and(|(lower, upper)| lower >= upper) {
    return Err(OrderKeyError::InvalidBounds);
  }

  let Some(lower) = lower else {
    let Some(upper) = upper else {
      return Ok("a0".to_string());
    };
    let integer = integer_part(upper)?;
    let fractional = &upper[integer.len()..];
    if integer == "A00000000000000000000000000" {
      return Ok(format!("{integer}{}", midpoint("", Some(fractional))?));
    }
    if integer < upper {
      return Ok(integer.to_string());
    }
    return decrement_integer(integer)?.ok_or(OrderKeyError::Exhausted);
  };

  let lower_integer = integer_part(lower)?;
  let lower_fractional = &lower[lower_integer.len()..];
  let Some(upper) = upper else {
    return match increment_integer(lower_integer)? {
      Some(integer) => Ok(integer),
      None => Ok(format!("{lower_integer}{}", midpoint(lower_fractional, None)?)),
    };
  };

  let upper_integer = integer_part(upper)?;
  let upper_fractional = &upper[upper_integer.len()..];
  if lower_integer == upper_integer {
    return Ok(format!(
      "{lower_integer}{}",
      midpoint(lower_fractional, Some(upper_fractional))?
    ));
  }
  let incremented = increment_integer(lower_integer)?.ok_or(OrderKeyError::Exhausted)?;
  if incremented.as_str() < upper {
    return Ok(incremented);
  }
  Ok(format!("{lower_integer}{}", midpoint(lower_fractional, None)?))
}

fn wrapper_subkey(key: &str) -> &str {
  if key.len() <= FULL_KEY_SUFFIX_LENGTH {
    key
  } else {
    &key[..key.len() - FULL_KEY_SUFFIX_LENGTH]
  }
}

fn integer_part(key: &str) -> Result<&str, OrderKeyError> {
  let length = integer_length(*key.as_bytes().first().ok_or(OrderKeyError::Invalid)?).ok_or(OrderKeyError::Invalid)?;
  key.get(..length).ok_or(OrderKeyError::Invalid)
}

fn integer_length(head: u8) -> Option<usize> {
  match head {
    b'a'..=b'z' => Some(usize::from(head - b'a') + 2),
    b'A'..=b'Z' => Some(usize::from(b'Z' - head) + 2),
    _ => None,
  }
}

fn digit_index(digit: u8) -> Option<usize> {
  BASE_62_DIGITS.iter().position(|candidate| *candidate == digit)
}

fn increment_integer(integer: &str) -> Result<Option<String>, OrderKeyError> {
  let bytes = integer.as_bytes();
  if bytes.len() != integer_length(bytes[0]).ok_or(OrderKeyError::Invalid)? {
    return Err(OrderKeyError::Invalid);
  }
  let head = bytes[0];
  let mut digits = bytes[1..].to_vec();
  let mut carry = true;
  for digit in digits.iter_mut().rev() {
    if !carry {
      break;
    }
    let next = digit_index(*digit).ok_or(OrderKeyError::Invalid)? + 1;
    if next == BASE_62_DIGITS.len() {
      *digit = BASE_62_DIGITS[0];
    } else {
      *digit = BASE_62_DIGITS[next];
      carry = false;
    }
  }
  if carry {
    match head {
      b'Z' => return Ok(Some("a0".to_string())),
      b'z' => return Ok(None),
      _ => {
        let next_head = head + 1;
        if next_head > b'a' {
          digits.push(BASE_62_DIGITS[0]);
        } else {
          digits.pop();
        }
        return Ok(Some(assemble_integer(next_head, &digits)));
      }
    }
  }
  Ok(Some(assemble_integer(head, &digits)))
}

fn decrement_integer(integer: &str) -> Result<Option<String>, OrderKeyError> {
  let bytes = integer.as_bytes();
  if bytes.len() != integer_length(bytes[0]).ok_or(OrderKeyError::Invalid)? {
    return Err(OrderKeyError::Invalid);
  }
  let head = bytes[0];
  let mut digits = bytes[1..].to_vec();
  let mut borrow = true;
  for digit in digits.iter_mut().rev() {
    if !borrow {
      break;
    }
    let current = digit_index(*digit).ok_or(OrderKeyError::Invalid)?;
    if current == 0 {
      *digit = *BASE_62_DIGITS.last().expect("base-62 digits are non-empty");
    } else {
      *digit = BASE_62_DIGITS[current - 1];
      borrow = false;
    }
  }
  if borrow {
    match head {
      b'a' => return Ok(Some("Zz".to_string())),
      b'A' => return Ok(None),
      _ => {
        let next_head = head - 1;
        if next_head < b'Z' {
          digits.push(*BASE_62_DIGITS.last().expect("base-62 digits are non-empty"));
        } else {
          digits.pop();
        }
        return Ok(Some(assemble_integer(next_head, &digits)));
      }
    }
  }
  Ok(Some(assemble_integer(head, &digits)))
}

fn assemble_integer(head: u8, digits: &[u8]) -> String {
  let mut result = String::with_capacity(digits.len() + 1);
  result.push(char::from(head));
  result.extend(digits.iter().map(|digit| char::from(*digit)));
  result
}

fn midpoint(lower: &str, upper: Option<&str>) -> Result<String, OrderKeyError> {
  if upper.is_some_and(|upper| lower >= upper)
    || lower.as_bytes().last() == Some(&BASE_62_DIGITS[0])
    || upper.is_some_and(|upper| upper.as_bytes().last() == Some(&BASE_62_DIGITS[0]))
  {
    return Err(OrderKeyError::InvalidBounds);
  }
  if let Some(upper) = upper {
    let mut common = 0;
    while upper
      .as_bytes()
      .get(common)
      .is_some_and(|upper_digit| lower.as_bytes().get(common).copied().unwrap_or(BASE_62_DIGITS[0]) == *upper_digit)
    {
      common += 1;
    }
    if common > 0 {
      return Ok(format!(
        "{}{}",
        &upper[..common],
        midpoint(&lower[common.min(lower.len())..], Some(&upper[common..]))?
      ));
    }
  }

  let lower_digit = lower
    .as_bytes()
    .first()
    .map(|digit| digit_index(*digit).ok_or(OrderKeyError::Invalid))
    .transpose()?
    .unwrap_or(0);
  let upper_digit = upper
    .and_then(|upper| upper.as_bytes().first())
    .map(|digit| digit_index(*digit).ok_or(OrderKeyError::Invalid))
    .transpose()?
    .unwrap_or(BASE_62_DIGITS.len());
  if upper_digit.saturating_sub(lower_digit) > 1 {
    let midpoint = (lower_digit + upper_digit + 1) / 2;
    return Ok(char::from(BASE_62_DIGITS[midpoint]).to_string());
  }
  if let Some(upper) = upper.filter(|upper| upper.len() > 1) {
    return Ok(upper[..1].to_string());
  }
  let mut result = String::from(char::from(BASE_62_DIGITS[lower_digit]));
  result.push_str(midpoint(lower.get(1..).unwrap_or_default(), None)?.as_str());
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde::Deserialize;
  use std::sync::{Arc, Barrier};

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct ContractFixture {
    version: u32,
    valid_keys: Vec<String>,
    invalid_keys: Vec<String>,
    relations: Vec<Relation>,
  }

  #[derive(Deserialize)]
  struct Relation {
    name: String,
    lower: Option<String>,
    upper: Option<String>,
    advance: String,
    iterations: usize,
  }

  #[test]
  fn shared_fractional_indexing_contract_matches_server_generator() {
    let fixture: ContractFixture = serde_json::from_str(include_str!(
      "../../../../build/fixtures/contracts/organizer-fractional-indexing.json"
    ))
    .expect("shared Organizer order-key fixture");
    assert_eq!(fixture.version, 1);
    for key in fixture.valid_keys {
      assert!(is_valid_order_key(&key), "fixture key should be valid: {key}");
    }
    for key in fixture.invalid_keys {
      assert!(!is_valid_order_key(&key), "fixture key should be invalid: {key}");
    }
    for relation in fixture.relations {
      let mut lower = relation.lower;
      let mut upper = relation.upper;
      let mut generated = Vec::new();
      for _ in 0..relation.iterations {
        let key = generate_order_key_between(lower.as_deref(), upper.as_deref())
          .unwrap_or_else(|error| panic!("{} generation failed: {error:?}", relation.name));
        assert!(
          is_valid_order_key(&key),
          "{} generated invalid key {key}",
          relation.name
        );
        assert!(lower.as_ref().is_none_or(|lower| lower < &key));
        assert!(upper.as_ref().is_none_or(|upper| &key < upper));
        assert!(!generated.contains(&key), "{} generated a duplicate", relation.name);
        generated.push(key.clone());
        match relation.advance.as_str() {
          "lower" => lower = Some(key),
          "upper" => upper = Some(key),
          other => panic!("unsupported fixture advance {other}"),
        }
      }
    }
  }

  #[test]
  fn concurrent_generators_do_not_reuse_full_keys() {
    let barrier = Arc::new(Barrier::new(8));
    let handles = (0..8)
      .map(|_| {
        let barrier = barrier.clone();
        std::thread::spawn(move || {
          barrier.wait();
          generate_order_key_between(Some("a0"), None).expect("concurrent append key")
        })
      })
      .collect::<Vec<_>>();
    let keys = handles
      .into_iter()
      .map(|handle| handle.join().expect("generator thread"))
      .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(keys.len(), 8);
  }
}
