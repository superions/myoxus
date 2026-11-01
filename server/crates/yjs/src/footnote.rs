// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};
use yrs::{Any, Map, MapRef, ReadTxn};

/// Native definition placement, independent of its technical Markdown label.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FootnotePlacement {
  #[default]
  Footnote,
  Endnote,
}

/// Existing snapshots without the property mean footnote. Invalid values must
/// remain a diagnosed error rather than silently selecting an output kind.
pub fn read_placement<T: ReadTxn>(block: &MapRef, txn: &T) -> Result<FootnotePlacement, &'static str> {
  match block.get(txn, "prop:placement").or_else(|| block.get(txn, "placement")) {
    None => Ok(FootnotePlacement::Footnote),
    Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == "footnote" => Ok(FootnotePlacement::Footnote),
    Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == "endnote" => Ok(FootnotePlacement::Endnote),
    _ => Err("Invalid native footnote placement"),
  }
}
