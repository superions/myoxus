// SPDX-License-Identifier: AGPL-3.0-or-later
// Keep Organizer callers and errors on the shared, unchanged native generator.
pub(crate) use yjs::order_key::{
  OrderKeyError, generate_base_key_between, generate_order_key_between, is_valid_order_key, validate_order_key,
};
