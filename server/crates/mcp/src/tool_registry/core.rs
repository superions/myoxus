// SPDX-License-Identifier: AGPL-3.0-or-later
//! Existing non-Database projections, including diagnostic success variants.
//! These declarations describe serializers; they never remap product payloads.

use serde_json::Value;
use std::sync::OnceLock;

pub(super) fn output_schema(name: &str) -> Option<Value> {
  static CONTRACTS: OnceLock<Value> = OnceLock::new();
  let contracts = CONTRACTS
    .get_or_init(|| serde_json::from_str(include_str!("core-contracts.json")).expect("valid core output contracts"));
  Some(super::database::with_definitions(
    contracts["tools"].get(name)?.clone(),
    &contracts["$defs"],
  ))
}
