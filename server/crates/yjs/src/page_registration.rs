// SPDX-License-Identifier: AGPL-3.0-or-later

use yrs::{Any, Array, Doc, GetString, Map, ReadTxn, Transact};

/// Extra lifecycle work requested only for an unfinished creation or its root.
#[derive(Debug, Clone, Default)]
pub enum PageRegistrationRequest {
  #[default]
  None,
  Leaf {
    external_id: String,
  },
  Root {
    intents: Vec<(String, String)>,
    retired: Vec<String>,
  },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageRegistrationProjection {
  pub creation_intent: Option<String>,
  /// None means incomplete/ambiguous page structure, not a valid empty title.
  pub title: Option<String>,
  pub root_delta: Option<Vec<u8>>,
}

fn string(value: Option<yrs::Out>) -> Option<String> {
  match value {
    Some(yrs::Out::Any(Any::String(value))) => Some(value.to_string()),
    _ => None,
  }
}

/// Read title evidence from exactly one valid page block, preserving empty
/// titles in the supported persisted layouts without a heading fallback.
pub fn extract_page_title(update: &[u8]) -> Result<Option<String>, String> {
  use yrs::updates::decoder::Decode;
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(update).map_err(|error| error.to_string())?)
    .map_err(|error| error.to_string())?;
  Ok(
    project(
      &doc,
      &PageRegistrationRequest::Leaf {
        external_id: String::new(),
      },
    )
    .title,
  )
}

pub(crate) fn project(doc: &Doc, request: &PageRegistrationRequest) -> PageRegistrationProjection {
  let mut result = PageRegistrationProjection::default();
  match request {
    PageRegistrationRequest::None => {}
    PageRegistrationRequest::Leaf { external_id } => {
      let txn = doc.transact();
      if let Some(meta) = txn.get_map("meta")
        && string(meta.get(&txn, "pageCreationId")).as_deref() == Some(external_id)
      {
        result.creation_intent =
          string(meta.get(&txn, "pageCreationIntent")).filter(|intent| !intent.is_empty() && intent.len() <= 128);
      }
      let Some(blocks) = txn.get_map("blocks") else {
        return result;
      };
      let pages: Vec<_> = blocks
        .iter(&txn)
        .filter_map(|(_, value)| {
          let yrs::Out::YMap(block) = value else { return None };
          string(block.get(&txn, "sys:flavour").or_else(|| block.get(&txn, "flavour")))
            .is_some_and(|flavour| crate::resolve_flavour(&flavour) == "myoxus:page")
            .then_some(block)
        })
        .collect();
      if pages.len() == 1 {
        let title = pages[0].get(&txn, "prop:title").or_else(|| {
          let yrs::Out::YMap(props) = pages[0].get(&txn, "props")? else {
            return None;
          };
          props.get(&txn, "title")
        });
        result.title = match title {
          Some(yrs::Out::YText(title)) => Some(title.get_string(&txn)),
          Some(yrs::Out::Any(Any::String(title))) => Some(title.to_string()),
          _ => None,
        };
      }
    }
    PageRegistrationRequest::Root { intents, retired } => {
      let mut txn = doc.transact_mut();
      let Some(meta) = txn.get_map("meta") else { return result };
      let Some(yrs::Out::YArray(pages)) = meta.get(&txn, "pages") else {
        return result;
      };
      let before = txn.state_vector();
      let known: std::collections::HashSet<_> = intents
        .iter()
        .map(|(id, intent)| (id.as_str(), intent.as_str()))
        .collect();
      let mut entries = std::collections::HashMap::<_, Vec<(u32, bool)>>::new();
      let mut duplicates = Vec::new();
      let retired: std::collections::HashSet<_> = retired.iter().map(String::as_str).collect();
      for (index, value) in pages.iter(&txn).enumerate() {
        let yrs::Out::YMap(page) = value else { continue };
        let Some(id) = string(page.get(&txn, "id")) else {
          continue;
        };
        // A first delivery can arrive after deletion or Move, so CRDT deletion
        // alone cannot reject an entry the server had never observed.
        if retired.contains(id.as_str()) {
          duplicates.push(index as u32);
          continue;
        }
        let Some(intent) = string(page.get(&txn, "creationIntent")) else {
          continue;
        };
        if known.contains(&(id.as_str(), intent.as_str())) {
          let registered = matches!(
            page.get(&txn, "registrationOwner"),
            Some(yrs::Out::Any(Any::Bool(true)))
          );
          entries
            .entry((id, intent))
            .or_default()
            .push((index as u32, registered));
        }
      }
      // Only duplicate deliveries of the same explicit creation are folded.
      // Unmarked legacy entries and different creation intents remain untouched.
      // Prefer the entry previously confirmed by the server so array ordering
      // cannot let a delayed create overwrite its subsequent trash/title state.
      for entries in entries.values() {
        let keep = entries
          .iter()
          .find(|(_, registered)| *registered)
          .unwrap_or(&entries[0])
          .0;
        duplicates.extend(
          entries
            .iter()
            .filter_map(|(index, _)| (*index != keep).then_some(*index)),
        );
      }
      duplicates.sort_unstable();
      for index in duplicates.iter().rev() {
        pages.remove(&mut txn, *index);
      }
      if !duplicates.is_empty() {
        result.root_delta = Some(txn.encode_diff_v1(&before));
      }
    }
  }
  result
}

/// Attach the same creation identity to the server's root entry. This lets a
/// delayed client root stream converge without treating legacy duplicates alike.
pub fn mark_root_creation(root: &[u8], external_id: &str, intent: &str) -> Result<Vec<u8>, String> {
  use yrs::updates::decoder::Decode;
  let doc = Doc::new();
  let mut txn = doc.transact_mut();
  txn
    .apply_update(yrs::Update::decode_v1(root).map_err(|e| e.to_string())?)
    .map_err(|e| e.to_string())?;
  let before = txn.state_vector();
  let Some(meta) = txn.get_map("meta") else {
    return Err("missing workspace metadata".into());
  };
  let Some(yrs::Out::YArray(pages)) = meta.get(&txn, "pages") else {
    return Err("missing page list".into());
  };
  let matches: Vec<_> = pages
    .iter(&txn)
    .filter_map(|value| {
      let yrs::Out::YMap(page) = value else { return None };
      (string(page.get(&txn, "id")).as_deref() == Some(external_id)).then_some(page)
    })
    .collect();
  if matches.len() != 1 {
    return Err("ambiguous page registration".into());
  }
  if let Some(existing) = string(matches[0].get(&txn, "creationIntent"))
    && existing != intent
  {
    return Err("conflicting page creation intent".into());
  }
  matches[0].insert(&mut txn, "creationIntent", intent);
  matches[0].insert(&mut txn, "registrationOwner", true);
  Ok(txn.encode_diff_v1(&before))
}

/// Fold only replayed root entries carrying the same explicit creation intent.
pub fn fold_root_creation(root: &[u8], external_id: &str, intent: &str) -> Result<Option<Vec<u8>>, String> {
  use yrs::updates::decoder::Decode;
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(root).map_err(|e| e.to_string())?)
    .map_err(|e| e.to_string())?;
  Ok(
    project(
      &doc,
      &PageRegistrationRequest::Root {
        intents: vec![(external_id.to_owned(), intent.to_owned())],
        retired: Vec::new(),
      },
    )
    .root_delta,
  )
}
