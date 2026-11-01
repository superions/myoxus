// SPDX-License-Identifier: AGPL-3.0-or-later
//! Merge algorithm for combining multiple Yjs v1 updates.
//!
//! Clean reimplementation. Produces identical output to y-octo `Update::merge`.
//!
//! ## Deviation C-01: Clock-gap filling with Skip nodes
//!
//! After merging, if two consecutive structs for the same client have a clock
//! gap (`cur.clock + cur.len < next.clock`), a `Node::Skip` is inserted to
//! fill the gap. This ensures the update is well-formed for downstream
//! consumers (y-crdt, yrs, Virgultum).
//!
//! ## Deviation C-02: Duplicate dedup
//!
//! When two nodes have the same starting clock, they are considered duplicates
//! if they also share `deleted` status and `last_id`. The second copy is
//! removed.
//!
//! ## Deviation C-03: Sort before merge
//!
//! Within each client, structs are sorted by clock before gap-filling and
//! dedup. This normalizes out-of-order inputs from different update sources.
//!
//! ## Deviation C-04: Skip nodes stripped on merge input
//!
//! Skip nodes from input updates are filtered out before merging, since the
//! merge algorithm generates its own Skip nodes to fill gaps.

use std::collections::VecDeque;

use tracing::debug;

use super::error::CodecResult;
use super::item::{Id, Node};
use super::update::Update;

/// Merge multiple Yjs v1 update binaries into a single `Update`.
///
/// Operates at the binary level — no Doc object, no random client ID.
/// Deterministic: identical inputs always produce identical bytes.
///
/// Empty or zero-length inputs are silently skipped.
pub fn merge_updates_v1<V: AsRef<[u8]>>(updates: impl IntoIterator<Item = V>) -> CodecResult<Update> {
  let decoded = updates
    .into_iter()
    .map(|b| Update::decode_v1(b.as_ref()))
    .collect::<CodecResult<Vec<_>>>()?;
  Ok(merge(decoded))
}

/// Merge decoded updates into a single update.
///
/// Algorithm:
/// 1. Collect all delete sets (union).
/// 2. Collect all structs per client, filtering out Skip nodes (C-04).
/// 3. Sort each client's structs by clock (C-03).
/// 4. Insert Skip nodes to fill clock gaps (C-01).
/// 5. Remove duplicate nodes with same clock (C-02).
pub fn merge(updates: impl IntoIterator<Item = Update>) -> Update {
  let mut target = Update::default();

  // Step 1+2: Collect structs and merge delete sets.
  for update in updates {
    target.set_delete_set({
      let mut ds = target.clone_delete_set();
      ds.merge(&update.clone_delete_set());
      ds
    });

    for (client, structs) in update.structs {
      // DEVIATION C-04: filter out Skip nodes from input.
      let iter = structs.into_iter().filter(|n| !n.is_skip());
      if let Some(merged) = target.structs.get_mut(&client) {
        merged.extend(iter);
      } else {
        target.structs.insert(client, iter.collect());
      }
    }
  }

  // Steps 3-5: Sort, gap-fill, dedup per client.
  for structs in target.structs.values_mut() {
    // DEVIATION C-03: sort by clock.
    structs.make_contiguous().sort_by_key(|s| s.id().clock);

    // DEVIATION C-01 + C-02: gap-fill and dedup in a single pass.
    let mut index = 0;
    let mut remove_indices = Vec::new();

    while index + 1 < structs.len() {
      let cur_clock = structs[index].id().clock;
      let cur_len = structs[index].len();
      let cur_client = structs[index].id().client;
      let cur_clock_end = cur_clock + cur_len;
      let next_clock = structs[index + 1].id().clock;

      if next_clock > cur_clock_end {
        // DEVIATION C-01: clock gap → insert Skip node.
        structs.insert(
          index + 1,
          Node::Skip {
            id: Id::new(cur_client, cur_clock_end),
            len: next_clock - cur_clock_end,
          },
        );
        index += 1; // skip past the newly inserted node
      } else if cur_clock == next_clock {
        // DEVIATION C-02: same clock → check if duplicate.
        let cur_deleted = structs[index].deleted();
        let next_deleted = structs[index + 1].deleted();
        let cur_last = last_id(&structs[index]);
        let next_last = last_id(&structs[index + 1]);

        if cur_deleted == next_deleted && cur_last == next_last {
          remove_indices.push(index + 1);
        } else {
          debug!(
            "merge: non-identical duplicate at clock {}: {:?} vs {:?}",
            cur_clock,
            &structs[index],
            &structs[index + 1]
          );
        }
      }

      index += 1;
    }

    // Prune duplicates (in reverse to preserve indices).
    if !remove_indices.is_empty() {
      let mut new_structs = VecDeque::with_capacity(structs.len() - remove_indices.len());
      let mut remove_idx = 0;
      for (idx, val) in structs.drain(..).enumerate() {
        if remove_idx < remove_indices.len() && idx == remove_indices[remove_idx] {
          remove_idx += 1;
        } else {
          new_structs.push_back(val);
        }
      }
      structs.extend(new_structs);
    }
  }

  target
}

/// Compute the last Id of a node (for dedup comparison).
fn last_id(node: &Node) -> Id {
  let id = node.id();
  let len = node.len();
  if len == 0 {
    id
  } else {
    Id::new(id.client, id.clock + len - 1)
  }
}
