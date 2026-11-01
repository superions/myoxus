// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical password-length policy shared by every password-setting ingress.

use async_trait::async_trait;

use super::{AuthError, AuthResult};

pub const DEFAULT_PASSWORD_MIN_LENGTH: usize = 8;
pub const DEFAULT_PASSWORD_MAX_LENGTH: usize = 128;
pub const ABSOLUTE_PASSWORD_MAX_LENGTH: usize = 1_024;

/// Validated password-length policy exposed to clients and enforced by the
/// application service before hashing or persistence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PasswordPolicy {
  min_length: usize,
  max_length: usize,
}

impl PasswordPolicy {
  pub fn new(min_length: usize, max_length: usize) -> AuthResult<Self> {
    if min_length == 0 || min_length > max_length || max_length > ABSOLUTE_PASSWORD_MAX_LENGTH {
      return Err(AuthError::InvalidInput(format!(
        "password policy must satisfy 0 < min <= max <= {ABSOLUTE_PASSWORD_MAX_LENGTH}"
      )));
    }
    Ok(Self { min_length, max_length })
  }

  pub const fn min_length(self) -> usize {
    self.min_length
  }

  pub const fn max_length(self) -> usize {
    self.max_length
  }

  /// Count UTF-16 code units so the server agrees exactly with JavaScript
  /// `String.length` and HTML `minLength`/`maxLength`, including astral code
  /// points such as emoji.
  pub fn validate(self, password: &str) -> AuthResult<()> {
    let length = password.encode_utf16().count();
    if length < self.min_length {
      return Err(AuthError::InvalidInput(format!(
        "password must contain at least {} characters",
        self.min_length
      )));
    }
    if length > self.max_length {
      return Err(AuthError::InvalidInput(format!(
        "password must contain at most {} characters",
        self.max_length
      )));
    }
    Ok(())
  }
}

impl Default for PasswordPolicy {
  fn default() -> Self {
    Self {
      min_length: DEFAULT_PASSWORD_MIN_LENGTH,
      max_length: DEFAULT_PASSWORD_MAX_LENGTH,
    }
  }
}

/// Runtime source for the effective password policy. Implementations must
/// fail closed when a persisted policy is malformed instead of silently
/// hashing a password under a different contract than clients were shown.
#[async_trait]
pub trait PasswordPolicyProvider: Send + Sync {
  async fn current_policy(&self) -> AuthResult<PasswordPolicy>;
}

#[derive(Clone)]
pub struct StaticPasswordPolicyProvider {
  policy: PasswordPolicy,
}

impl StaticPasswordPolicyProvider {
  pub const fn new(policy: PasswordPolicy) -> Self {
    Self { policy }
  }
}

impl Default for StaticPasswordPolicyProvider {
  fn default() -> Self {
    Self::new(PasswordPolicy::default())
  }
}

#[async_trait]
impl PasswordPolicyProvider for StaticPasswordPolicyProvider {
  async fn current_policy(&self) -> AuthResult<PasswordPolicy> {
    Ok(self.policy)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn policy_bounds_and_unicode_length_are_enforced() {
    assert!(PasswordPolicy::new(0, 8).is_err());
    assert!(PasswordPolicy::new(9, 8).is_err());
    assert!(PasswordPolicy::new(8, ABSOLUTE_PASSWORD_MAX_LENGTH + 1).is_err());

    let policy = PasswordPolicy::new(3, 4).expect("valid policy");
    assert!(policy.validate("ab").is_err());
    assert!(policy.validate("abc").is_ok());
    assert!(policy.validate("aß界").is_ok());
    assert!(policy.validate("a😀").is_ok(), "emoji occupies two UTF-16 units");
    assert!(policy.validate("😀😀").is_ok());
    assert!(policy.validate("abcde").is_err());
    assert!(policy.validate("a😀😀").is_err());
  }
}
