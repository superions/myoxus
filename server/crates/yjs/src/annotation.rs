// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native annotation identity shared by reading and interchange consumers.
use yrs::{Any, types::Attrs};

/// The body lives in the attributed Yjs text, never in this identity object.
pub fn annotation_id(attrs: Option<&Attrs>) -> Option<&str> {
  let Any::Map(value) = attrs?.get("annotation")? else {
    return None;
  };
  if value.len() != 1 {
    return None;
  }
  match value.get("id")? {
    Any::String(id) if !id.is_empty() => Some(id.as_ref()),
    _ => None,
  }
}

/// Rebind canonical annotation identities only on newly copied TextRefs. Share
/// the map across the whole subtree/axis copy; unknown attributes remain intact.
pub(crate) fn remap_copied_text(
  text: &yrs::TextRef,
  txn: &mut yrs::TransactionMut<'_>,
  identities: &mut std::collections::HashMap<String, String>,
) {
  use yrs::Text;
  let mut offset = 0;
  for run in text.diff(txn, |_| ()) {
    let length = match &run.insert {
      yrs::Out::Any(Any::String(value)) => value.len() as u32,
      _ => 1,
    };
    if let Some(old) = annotation_id(run.attributes.as_deref()) {
      let id = rebind_id(old, identities);
      text.format(
        txn,
        offset,
        length,
        Attrs::from([(
          "annotation".into(),
          Any::Map(std::sync::Arc::new(std::collections::HashMap::from([(
            "id".into(),
            Any::String(id.clone().into()),
          )]))),
        )]),
      );
    }
    offset += length;
  }
}

/// Replace one complete canonical inline body under the caller's content lock.
/// Native start disambiguates an identity reused in separated ranges, matching
/// the editor's getAnnotationRanges rule across adjacent attributed runs.
pub(crate) fn replace_body(
  text: &yrs::TextRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  start: u32,
  replacement: &str,
  expected: Option<&str>,
) -> Result<(), crate::DocumentMutationError> {
  use crate::DocumentMutationError as Error;
  use yrs::Text;
  let mut offset = 0;
  let mut previous_matches = false;
  let mut found = false;
  let mut length = 0;
  let mut body = String::new();
  for run in text.diff(txn, |_| ()) {
    let width = match &run.insert {
      yrs::Out::Any(Any::String(value)) => value.len() as u32,
      _ => 1,
    };
    let matches = annotation_id(run.attributes.as_deref()) == Some(id);
    if !found && offset == start && matches && !previous_matches {
      found = true;
    }
    if found {
      if !matches {
        break;
      }
      let yrs::Out::Any(Any::String(value)) = run.insert else {
        return Err(Error::InvalidTextRange);
      };
      body.push_str(&value);
      length += width;
    }
    previous_matches = matches;
    offset += width;
  }
  if !found || length == 0 {
    return Err(Error::TargetNotFound);
  }
  if expected.is_some_and(|expected| expected != body) {
    return Err(Error::ExpectedTextMismatch);
  }
  text.remove_range(txn, start, length);
  crate::insert_yjs_segments(
    text,
    txn,
    start,
    &[crate::YjsTextSegment {
      text: replacement.into(),
      annotation: Some(id.into()),
      ..Default::default()
    }],
  );
  Ok(())
}

/// Copies and new fragments share one map across their full insertion scope.
pub(crate) fn rebind_id(id: &str, identities: &mut std::collections::HashMap<String, String>) -> String {
  identities
    .entry(id.into())
    .or_insert_with(|| uuid::Uuid::new_v4().to_string())
    .clone()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_only_the_canonical_nonempty_identity() {
    let attrs = |annotation| Attrs::from([("annotation".into(), annotation)]);
    let identity = |id: &str| {
      Any::Map(std::sync::Arc::new(std::collections::HashMap::from([(
        "id".into(),
        Any::String(id.into()),
      )])))
    };
    assert_eq!(annotation_id(Some(&attrs(identity("a")))), Some("a"));
    assert_eq!(annotation_id(Some(&attrs(identity("")))), None);
    assert_eq!(annotation_id(None), None);
    assert_eq!(annotation_id(Some(&attrs(Any::String("a".into())))), None);
    let mut value = std::collections::HashMap::from([("id".into(), Any::String("a".into()))]);
    value.insert("body".into(), Any::String("not canonical".into()));
    assert_eq!(annotation_id(Some(&attrs(Any::Map(std::sync::Arc::new(value))))), None);
  }
}
