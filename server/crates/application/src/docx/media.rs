// SPDX-License-Identifier: AGPL-3.0-or-later
//! Readable, non-archival fallbacks from the already captured native document.

use myoxus_public_render::{Block, PublicDocIr};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub enum NativeFallback {
  File { key: Option<String>, name: Option<String> },
  External { url: Option<String>, label: Option<String> },
  Text { label: Option<String> },
}

pub struct ReadableFallback {
  pub label: String,
  pub url: Option<String>,
  pub explanation: Option<&'static str>,
  pub code: &'static str,
}

fn text(value: &Value) -> Option<String> {
  let text = value
    .as_str()
    .map(str::to_owned)
    .or_else(|| yjs::snapshot_rich_text_plain_text(value).ok())?;
  (!text.trim().is_empty()).then_some(text)
}

/// Inventory readable source properties before the reading IR discards them.
/// These are untrusted coordinates, not admitted labels: the transport must
/// authorize file metadata before constructing a `ReadableFallback`.
pub fn block_fallback_inventory(snapshot: &Value, ir: &PublicDocIr) -> BTreeMap<String, NativeFallback> {
  fn unsupported(blocks: &[Block], ids: &mut BTreeSet<String>) {
    for block in blocks {
      match block {
        Block::UnsupportedBlock { block_id, .. } => {
          ids.insert(block_id.clone());
        }
        Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => unsupported(children, ids),
        Block::List { list, .. } => {
          for item in &list.items {
            unsupported(&item.children, ids)
          }
        }
        _ => {}
      }
    }
  }
  let mut unknown = BTreeSet::new();
  unsupported(&ir.document.blocks, &mut unknown);
  let mut result = BTreeMap::new();
  for block in super::references::native_content_blocks(snapshot) {
    let Some(id) = block["id"].as_str() else {
      continue;
    };
    let flavour = block["flavour"].as_str().unwrap_or_default();
    let props = &block["props"];
    // Citation cards and document/Database references have existing semantic
    // owners. Never override them or expand their cached children as media.
    if matches!(
      flavour,
      "myoxus:database" | "myoxus:embed-linked-doc" | "myoxus:embed-synced-doc" | "myoxus:surface-ref"
    ) || props["style"] == "citation"
    {
      continue;
    }
    let mut labels = Vec::new();
    for name in ["title", "caption", "name", "text"] {
      if let Some(value) = text(&props[name])
        && !labels.contains(&value)
      {
        labels.push(value);
      }
    }
    let label = labels.join("\n");
    let label = (!label.is_empty()).then_some(label);
    let fallback = if matches!(flavour, "myoxus:attachment" | "myoxus:audio" | "myoxus:video") {
      NativeFallback::File {
        key: props["sourceId"].as_str().map(str::to_owned),
        name: text(&props["name"]).map(|name| name.rsplit(['/', '\\']).next().unwrap_or_default().to_string()),
      }
    } else if flavour.starts_with("myoxus:embed-") {
      NativeFallback::External {
        url: props["url"]
          .as_str()
          .or_else(|| props["src"].as_str())
          .map(str::to_owned),
        label,
      }
    } else if unknown.contains(id) {
      NativeFallback::Text { label }
    } else {
      continue;
    };
    result.insert(id.to_string(), fallback);
  }
  result
}

/// External widget destinations are referenced, never fetched. Credential-
/// carrying URLs and non-web schemes cannot become a portable document link.
pub fn safe_external_reference(value: &str) -> Option<String> {
  let url = url::Url::parse(value).ok()?;
  (matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none())
    .then(|| url.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_fallbacks_keep_unknown_text_and_count_each_construct_once_with_safe_destinations() {
    let mut builder = yjs::YjsDocumentBuilder::new("Readable fallbacks");
    builder.push_bookmark("https://example.org/widget", "External title");
    let external = builder.last_created_block_id().unwrap();
    builder.push_paragraph(&[yjs::YjsTextSegment::plain("Complete unknown Unicode text: Grüße")]);
    let unknown = builder.last_created_block_id().unwrap();
    builder.push_paragraph(&[yjs::YjsTextSegment::plain("")]);
    let empty = builder.last_created_block_id().unwrap();
    let original = builder.encode();
    let mut snapshot = yjs::native_snapshot::document_to_snapshot(&original, "source", "Readable fallbacks").unwrap();
    for block in snapshot["blocks"].as_array_mut().unwrap() {
      if block["id"] == external {
        block["flavour"] = "myoxus:embed-youtube".into();
      }
      if block["id"] == unknown || block["id"] == empty {
        block["flavour"] = "myoxus:future-widget".into();
      }
    }
    let blocks: Vec<yjs::PortableSnapshotBlock> = serde_json::from_value(snapshot["blocks"].clone()).unwrap();
    let binary = yjs::snapshot_blocks_to_yjs(&blocks).unwrap();
    let ir = crate::doc::content_projection::project_snapshot_for_export(
      uuid::Uuid::nil(),
      uuid::Uuid::new_v4(),
      "Readable fallbacks",
      &binary,
    )
    .unwrap();
    let native = yjs::native_snapshot::document_to_snapshot(&binary, "source", "Readable fallbacks").unwrap();
    let inventory = block_fallback_inventory(&native, &ir);
    assert!(matches!(&inventory[&unknown],NativeFallback::Text{label:Some(label)} if label.contains("Grüße")));
    assert!(matches!(&inventory[&empty], NativeFallback::Text { label: None }));
    let mut presentation = crate::docx::ExportReferencePresentation::default();
    for (id, item) in inventory {
      let fallback = match item {
        NativeFallback::External { url, label } => ReadableFallback {
          label: label.unwrap(),
          url: url.as_deref().and_then(safe_external_reference),
          explanation: Some("Widget/player is not embedded in Word."),
          code: "external_widget_normalized",
        },
        NativeFallback::Text { label } => ReadableFallback {
          code: if label.is_some() {
            "unsupported_block_normalized"
          } else {
            "unsupported_block_omitted"
          },
          label: label.unwrap_or_default(),
          url: None,
          explanation: None,
        },
        _ => panic!("No file fixture"),
      };
      presentation.fallbacks.insert(id, fallback);
    }
    let output = crate::docx::export::encode_test_snapshot_with_references(&binary, &[], presentation);
    for code in [
      "external_widget_normalized",
      "unsupported_block_normalized",
      "unsupported_block_omitted",
    ] {
      assert_eq!(
        output
          .warnings
          .iter()
          .find(|warning| warning.code == code)
          .unwrap()
          .count,
        1,
        "{code}"
      );
    }
    assert!(
      !output
        .warnings
        .iter()
        .any(|warning| warning.code == "source_construct_normalized")
    );
    let word = wordcraft_docx::read(&output.bytes).unwrap();
    let body = word
      .body
      .iter()
      .filter_map(|block| match &**block {
        wordcraft_doc::Block::Para(paragraph) => Some(paragraph.final_text()),
        _ => None,
      })
      .collect::<String>();
    assert!(
      body.contains("External title")
        && body.contains("Complete unknown Unicode text: Grüße")
        && body.contains("Widget/player is not embedded in Word.")
    );
    assert!(word.media.is_empty());
    let file = yjs::append_imported_attachments(
      &original,
      &[yjs::ImportedAttachment {
        source_id: "private-storage-key".into(),
        name: "PRIVATE CACHED FILENAME".into(),
        mime: "text/plain".into(),
        size: 5,
      }],
    )
    .unwrap();
    assert!(
      yjs::native_snapshot::document_to_snapshot(&file, "source", "Readable fallbacks").is_err(),
      "Restoration must not silently change BigInt properties"
    );
    let export_snapshot =
      yjs::native_snapshot::document_to_export_snapshot(&file, "source", "Readable fallbacks").unwrap();
    let file_ir = crate::doc::content_projection::project_snapshot_for_export(
      uuid::Uuid::nil(),
      uuid::Uuid::new_v4(),
      "Readable fallbacks",
      &file,
    )
    .unwrap();
    assert!(
      block_fallback_inventory(&export_snapshot, &file_ir)
        .values()
        .any(|item| matches!(item, NativeFallback::File { .. })),
      "Technical server-imported byte sizes must not discard media inventory"
    );
    let denied = crate::docx::export::encode_test_snapshot_with_references(&file, &[], Default::default());
    let denied = wordcraft_docx::read(&denied.bytes).unwrap();
    let denied = format!("{:?}", denied.body);
    assert!(!denied.contains("PRIVATE CACHED FILENAME") && !denied.contains("private-storage-key"));
    assert!(denied.contains("[Reference unavailable]"));
    for unsafe_url in [
      "file:///private/storage/key",
      "javascript:alert(1)",
      "https://user:secret@example.org/widget",
    ] {
      assert!(safe_external_reference(unsafe_url).is_none());
    }
  }
}
