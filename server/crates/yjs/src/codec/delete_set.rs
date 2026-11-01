// SPDX-License-Identifier: AGPL-3.0-or-later
//! DeleteSet — tracks which clock ranges have been deleted per client.
//!
//! Clean reimplementation. Wire format matches y-octo exactly.
//!
//! ## Deviation D-01: Range vs. Fragment encoding
//!
//! A single range writes `[1][clock][len]`. Multiple ranges write
//! `[N][clock1][len1]...[clockN][lenN]`.
//!
//! ## Deviation D-02: Descending client sort
//!
//! DeleteSet encodes clients **descending** (`b.cmp(a)`), same as Update
//! but opposite to StateVector.

use std::collections::VecDeque;
use std::collections::hash_map::Entry;
use std::ops::Range;

use super::error::CodecResult;
use super::hasher::{ClientMap, client_map_with_capacity};
use super::varint::{RawDecoder, RawEncoder};

// ────────────────────────────────────────────────────────────────────────────
// OrderRange — single range or fragment of ranges
// ────────────────────────────────────────────────────────────────────────────

/// Represents deleted clock ranges for a single client.
///
/// - `Range(r)` — exactly one contiguous deleted range.
/// - `Fragment(vec)` — multiple non-overlapping ranges.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum OrderRange {
  Range(Range<u64>),
  Fragment(VecDeque<Range<u64>>),
}

impl Default for OrderRange {
  fn default() -> Self {
    OrderRange::Range(0..0)
  }
}

impl OrderRange {
  pub fn is_empty(&self) -> bool {
    match self {
      OrderRange::Range(r) => r.is_empty(),
      OrderRange::Fragment(v) => v.is_empty(),
    }
  }

  /// Push a range, merging overlapping/adjacent ranges.
  pub fn push(&mut self, range: Range<u64>) {
    match self {
      OrderRange::Range(r) => {
        if r.is_empty() {
          *self = OrderRange::Range(range);
        } else if is_continuous(r, &range) {
          r.start = r.start.min(range.start);
          r.end = r.end.max(range.end);
        } else if r.start < range.start {
          *self = OrderRange::Fragment(VecDeque::from([r.clone(), range]));
        } else {
          *self = OrderRange::Fragment(VecDeque::from([range, r.clone()]));
        }
      }
      OrderRange::Fragment(ranges) => {
        if ranges.is_empty() {
          *self = OrderRange::Range(range);
        } else {
          push_sorted(ranges, range);
          self.collapse_single();
        }
      }
    }
  }

  /// Merge another OrderRange into this one.
  pub fn merge(&mut self, other: OrderRange) {
    for r in other.into_iter() {
      self.push(r);
    }
  }

  /// Read from Yjs v1 binary.
  pub fn read(dec: &mut RawDecoder) -> CodecResult<Self> {
    let num = dec.read_var_u64()? as usize;
    if num == 1 {
      let clock = dec.read_var_u64()?;
      let len = dec.read_var_u64()?;
      Ok(OrderRange::Range(clock..clock + len))
    } else {
      let mut ranges = VecDeque::with_capacity(num.min(1024));
      for _ in 0..num {
        let clock = dec.read_var_u64()?;
        let len = dec.read_var_u64()?;
        ranges.push_back(clock..clock + len);
      }
      Ok(OrderRange::Fragment(ranges))
    }
  }

  /// Write to Yjs v1 binary.
  pub fn write(&self, enc: &mut RawEncoder) {
    match self {
      OrderRange::Range(r) => {
        enc.write_var_u64(1);
        enc.write_var_u64(r.start);
        enc.write_var_u64(r.end - r.start);
      }
      OrderRange::Fragment(ranges) => {
        enc.write_var_u64(ranges.len() as u64);
        for r in ranges {
          enc.write_var_u64(r.start);
          enc.write_var_u64(r.end - r.start);
        }
      }
    }
  }

  fn collapse_single(&mut self) {
    if let OrderRange::Fragment(ranges) = self
      && ranges.len() == 1
    {
      *self = OrderRange::Range(ranges[0].clone());
    }
  }
}

impl From<Range<u64>> for OrderRange {
  fn from(r: Range<u64>) -> Self {
    OrderRange::Range(r)
  }
}

impl From<Vec<Range<u64>>> for OrderRange {
  fn from(v: Vec<Range<u64>>) -> Self {
    OrderRange::Fragment(v.into_iter().collect())
  }
}

/// Iterate over the individual ranges.
impl IntoIterator for OrderRange {
  type Item = Range<u64>;
  type IntoIter = OrderRangeIter;

  fn into_iter(self) -> Self::IntoIter {
    match self {
      OrderRange::Range(r) => OrderRangeIter::Single(Some(r)),
      OrderRange::Fragment(v) => OrderRangeIter::Fragment(v),
    }
  }
}

pub enum OrderRangeIter {
  Single(Option<Range<u64>>),
  Fragment(VecDeque<Range<u64>>),
}

impl Iterator for OrderRangeIter {
  type Item = Range<u64>;

  fn next(&mut self) -> Option<Self::Item> {
    match self {
      OrderRangeIter::Single(r) => r.take(),
      OrderRangeIter::Fragment(v) => v.pop_front(),
    }
  }
}

#[inline]
fn is_continuous(a: &Range<u64>, b: &Range<u64>) -> bool {
  a.end >= b.start && a.start <= b.end
}

/// Insert `range` into a sorted VecDeque, merging overlapping neighbors.
fn push_sorted(list: &mut VecDeque<Range<u64>>, range: Range<u64>) {
  let idx = list.binary_search_by(|r| {
    if is_continuous(r, &range) {
      std::cmp::Ordering::Equal
    } else if r.end < range.start {
      std::cmp::Ordering::Less
    } else {
      std::cmp::Ordering::Greater
    }
  });

  match idx {
    Ok(i) => {
      list[i] = list[i].start.min(range.start)..list[i].end.max(range.end);
      squash_around(list, i);
    }
    Err(i) => {
      list.insert(i, range);
      squash_around(list, i);
    }
  }
}

fn squash_around(list: &mut VecDeque<Range<u64>>, idx: usize) {
  // Merge with next neighbor.
  if idx + 1 < list.len() && is_continuous(&list[idx], &list[idx + 1]) {
    list[idx] = list[idx].start.min(list[idx + 1].start)..list[idx].end.max(list[idx + 1].end);
    list.remove(idx + 1);
  }
  // Merge with previous neighbor.
  if idx > 0 && is_continuous(&list[idx - 1], &list[idx]) {
    list[idx - 1] = list[idx - 1].start.min(list[idx].start)..list[idx - 1].end.max(list[idx].end);
    list.remove(idx);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DeleteSet
// ────────────────────────────────────────────────────────────────────────────

/// Tracks deleted clock ranges per client.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DeleteSet(pub ClientMap<OrderRange>);

impl DeleteSet {
  /// Add a deleted range for `client`.
  pub fn add(&mut self, client: u64, from: u64, len: u64) {
    self.add_range(client, from..from + len);
  }

  /// Add a deleted range for `client`.
  pub fn add_range(&mut self, client: u64, range: Range<u64>) {
    match self.0.entry(client) {
      Entry::Occupied(mut e) => {
        let r = e.get_mut();
        if r.is_empty() {
          *r = range.into();
        } else {
          r.push(range);
        }
      }
      Entry::Vacant(e) => {
        e.insert(range.into());
      }
    }
  }

  /// Merge another DeleteSet into this one.
  pub fn merge(&mut self, other: &DeleteSet) {
    for (client, range) in &other.0 {
      match self.0.entry(*client) {
        Entry::Occupied(mut e) => {
          e.get_mut().merge(range.clone());
        }
        Entry::Vacant(e) => {
          e.insert(range.clone());
        }
      }
    }
  }

  /// True when no ranges are tracked.
  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }

  /// Number of clients with ranges.
  pub fn len(&self) -> usize {
    self.0.len()
  }

  /// Decode from Yjs v1 binary.
  pub fn read(dec: &mut RawDecoder) -> CodecResult<Self> {
    let num_clients = dec.read_var_u64()? as usize;
    let mut map = client_map_with_capacity(num_clients.min(1024));
    for _ in 0..num_clients {
      let client = dec.read_var_u64()?;
      let ranges = OrderRange::read(dec)?;
      map.insert(client, ranges);
    }
    Ok(DeleteSet(map))
  }

  /// Encode to Yjs v1 binary.
  ///
  /// **Deviation D-02**: clients sorted **descending** (`b.cmp(a)`).
  pub fn write(&self, enc: &mut RawEncoder) {
    enc.write_var_u64(self.0.len() as u64);
    let mut clients: Vec<_> = self.0.keys().copied().collect();
    // DEVIATION D-02: descending sort.
    clients.sort_by(|a, b| b.cmp(a));
    for client in clients {
      enc.write_var_u64(client);
      self.0[&client].write(enc);
    }
  }
}
