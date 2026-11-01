// SPDX-License-Identifier: AGPL-3.0-or-later
//! Item, Node, Id — CRDT item types for the Yjs v1 binary format.
//!
//! Clean reimplementation. Wire format matches y-octo exactly.
//!
//! ## Deviation E-01: Info byte values
//!
//! - info == 0  → GC node (garbage collected)
//! - info == 10 → Skip node
//! - otherwise  → Item (first 5 bits = content tag, upper bits = flags)
//!
//! ## Deviation E-02: ITEM_HAS_SIBLING = LEFT | RIGHT
//!
//! When an item has left OR right origin, no parent field is encoded.
//! Parent is only present when `!has_sibling` (neither left nor right).
//!
//! ## Deviation E-03: Parent field: String vs. Id
//!
//! `[varint: 1]` → parent is a named root type (String).
//! `[varint: 0]` → parent is an item ID.
//!
//! ## Deviation E-04: parent_sub only when `!has_sibling AND has_parent_sub`
//! ## Deviation E-05: deleted/countable flags derived from Content

use super::content::Content;
use super::error::CodecResult;
use super::varint::{RawDecoder, RawEncoder};

// ── Flag constants ──────────────────────────────────────────────────────────

pub const ITEM_HAS_LEFT_ID: u8 = 0b1000_0000;
pub const ITEM_HAS_RIGHT_ID: u8 = 0b0100_0000;
pub const ITEM_HAS_PARENT_SUB: u8 = 0b0010_0000;
pub const ITEM_HAS_SIBLING: u8 = ITEM_HAS_LEFT_ID | ITEM_HAS_RIGHT_ID;

// ── Id ──────────────────────────────────────────────────────────────────────

/// Unique CRDT identifier: (client, clock).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Id {
  pub client: u64,
  pub clock: u64,
}

impl Id {
  pub fn new(client: u64, clock: u64) -> Self {
    Self { client, clock }
  }
}

impl From<(u64, u64)> for Id {
  fn from((client, clock): (u64, u64)) -> Self {
    Id { client, clock }
  }
}

impl std::fmt::Display for Id {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "({}, {})", self.client, self.clock)
  }
}

// ── Parent ──────────────────────────────────────────────────────────────────

/// Parent reference for an item without siblings.
#[derive(Debug, Clone, PartialEq)]
pub enum Parent {
  /// Root type identified by name (e.g. "meta", "blocks").
  Named(String),
  /// Nested item identified by ID.
  Id(Id),
}

// ── Item ────────────────────────────────────────────────────────────────────

/// A single CRDT item in the Yjs document.
#[derive(Debug, Clone)]
pub struct Item {
  pub id: Id,
  pub origin_left_id: Option<Id>,
  pub origin_right_id: Option<Id>,
  pub parent: Option<Parent>,
  pub parent_sub: Option<String>,
  pub content: Content,
  /// Derived from content type (deviation E-05).
  pub deleted: bool,
  /// Derived from content type (deviation E-05).
  pub countable: bool,
}

impl PartialEq for Item {
  fn eq(&self, other: &Self) -> bool {
    self.id == other.id
  }
}

impl Item {
  /// Clock length of this item (delegates to content).
  pub fn len(&self) -> u64 {
    self.content.clock_len()
  }

  /// Whether this item has zero clock length.
  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }

  /// The last Id covered by this item: `(client, clock + len - 1)`.
  pub fn last_id(&self) -> Id {
    Id::new(self.id.client, self.id.clock + self.len() - 1)
  }

  /// Construct the info byte for encoding.
  fn info_byte(&self) -> u8 {
    let mut info = self.content.tag();
    if self.origin_left_id.is_some() {
      info |= ITEM_HAS_LEFT_ID;
    }
    if self.origin_right_id.is_some() {
      info |= ITEM_HAS_RIGHT_ID;
    }
    if self.parent_sub.is_some() {
      info |= ITEM_HAS_PARENT_SUB;
    }
    info
  }

  /// Read an Item from the wire (info byte and first_5_bit already known).
  pub fn read(dec: &mut RawDecoder, id: Id, info: u8, tag: u8) -> CodecResult<Self> {
    let has_left = info & ITEM_HAS_LEFT_ID != 0;
    let has_right = info & ITEM_HAS_RIGHT_ID != 0;
    let has_parent_sub = info & ITEM_HAS_PARENT_SUB != 0;
    let has_sibling = info & ITEM_HAS_SIBLING != 0;

    let origin_left_id = if has_left { Some(dec.read_item_id()?) } else { None };

    let origin_right_id = if has_right { Some(dec.read_item_id()?) } else { None };

    // DEVIATION E-02: parent only when no sibling.
    let parent = if !has_sibling {
      // DEVIATION E-03: 1 = Named(String), 0 = Id.
      let is_named = dec.read_var_u64()? == 1;
      Some(if is_named {
        Parent::Named(dec.read_var_string()?)
      } else {
        Parent::Id(dec.read_item_id()?)
      })
    } else {
      None
    };

    // DEVIATION E-04: parent_sub only when !sibling AND has_parent_sub.
    let parent_sub = if !has_sibling && has_parent_sub {
      Some(dec.read_var_string()?)
    } else {
      None
    };

    let content = Content::read(dec, tag)?;

    // DEVIATION E-05: flags derived from content type.
    let deleted = matches!(content, Content::Deleted(_));
    let countable = content.countable();

    Ok(Item {
      id,
      origin_left_id,
      origin_right_id,
      parent,
      parent_sub,
      content,
      deleted,
      countable,
    })
  }

  /// Write this Item to the wire.
  pub fn write(&self, enc: &mut RawEncoder) -> CodecResult<()> {
    let info = self.info_byte();
    enc.write_u8(info);

    if let Some(left) = &self.origin_left_id {
      enc.write_item_id(left);
    }
    if let Some(right) = &self.origin_right_id {
      enc.write_item_id(right);
    }

    let has_sibling = info & ITEM_HAS_SIBLING != 0;
    if !has_sibling {
      if let Some(parent) = &self.parent {
        match parent {
          Parent::Named(name) => {
            enc.write_var_u64(1);
            enc.write_var_string(name);
          }
          Parent::Id(id) => {
            enc.write_var_u64(0);
            enc.write_item_id(id);
          }
        }
      }

      if let Some(sub) = &self.parent_sub {
        enc.write_var_string(sub);
      }
    }

    self.content.write(enc)?;
    Ok(())
  }
}

// ── Node ────────────────────────────────────────────────────────────────────

/// A node in the update's struct list: GC, Skip, or Item.
///
/// **Deviation E-01**: GC has info byte 0, Skip has info byte 10.
#[derive(Debug, Clone)]
pub enum Node {
  /// Garbage-collected range.
  GC { id: Id, len: u64 },
  /// Skipped clock range (gap filler during merge).
  Skip { id: Id, len: u64 },
  /// Regular CRDT item.
  Item(Item),
}

impl Node {
  /// The ID of this node.
  pub fn id(&self) -> Id {
    match self {
      Node::GC { id, .. } => *id,
      Node::Skip { id, .. } => *id,
      Node::Item(item) => item.id,
    }
  }

  /// The clock length of this node.
  pub fn len(&self) -> u64 {
    match self {
      Node::GC { len, .. } => *len,
      Node::Skip { len, .. } => *len,
      Node::Item(item) => item.len(),
    }
  }

  /// Whether this node has zero clock length.
  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }

  /// Whether this node represents a deleted item.
  pub fn deleted(&self) -> bool {
    match self {
      Node::GC { .. } => true,
      Node::Skip { .. } => false,
      Node::Item(item) => item.deleted,
    }
  }

  /// Whether this is a Skip node.
  pub fn is_skip(&self) -> bool {
    matches!(self, Node::Skip { .. })
  }

  /// Read a Node from the wire, given the current Id (clock tracked externally).
  pub fn read(dec: &mut RawDecoder, id: Id) -> CodecResult<Self> {
    let info = dec.read_u8()?;
    let first_5_bit = info & 0b11111;

    match first_5_bit {
      // DEVIATION E-01: GC = info byte 0.
      0 => {
        let len = dec.read_var_u64()?;
        Ok(Node::GC { id, len })
      }
      // DEVIATION E-01: Skip = info byte 10.
      10 => {
        let len = dec.read_var_u64()?;
        Ok(Node::Skip { id, len })
      }
      // Item: content tag in first 5 bits, flags in upper 3 bits.
      tag => {
        let item = Item::read(dec, id, info, tag)?;
        Ok(Node::Item(item))
      }
    }
  }

  /// Write this Node to the wire.
  pub fn write(&self, enc: &mut RawEncoder) -> CodecResult<()> {
    match self {
      Node::GC { len, .. } => {
        enc.write_u8(0); // info byte = 0
        enc.write_var_u64(*len);
        Ok(())
      }
      Node::Skip { len, .. } => {
        enc.write_u8(10); // info byte = 10
        enc.write_var_u64(*len);
        Ok(())
      }
      Node::Item(item) => item.write(enc),
    }
  }
}

impl PartialEq for Node {
  fn eq(&self, other: &Self) -> bool {
    match (self, other) {
      (Node::GC { id: a, .. }, Node::GC { id: b, .. }) => a == b,
      (Node::Skip { id: a, .. }, Node::Skip { id: b, .. }) => a == b,
      (Node::Item(a), Node::Item(b)) => a == b,
      _ => false,
    }
  }
}
