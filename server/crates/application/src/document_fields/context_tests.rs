// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{context::*, *};
use myoxus_domain::entities::*;
use uuid::Uuid;
use yjs::document_field::{MetadataFormat, MetadataKey};

fn facts() -> DocumentFieldFacts {
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let user = Uuid::new_v4();
  let version_id = Uuid::new_v4();
  let instant = "2026-11-05T23:45:00Z".parse().unwrap();
  let reference = |id, key: &str, label: &str| DocumentMetadataReferenceValue {
    id,
    key: key.into(),
    label: label.into(),
    is_active: true,
  };
  let value = |key: &str, reference, text, user_id| DocumentMetadataFieldValue {
    key: key.into(),
    source: DocumentMetadataSource::Document,
    reference,
    text_value: text,
    user_id,
    timestamp_value: None,
    date_value: None,
  };
  DocumentFieldFacts {
    workspace_id,
    doc_id,
    title: Some("Containing document".into()),
    metadata: Some(DocumentMetadataProjection {
      doc_id,
      workspace_id,
      projection_version: "metadata:17;catalog:3".into(),
      metadata_revision: 17,
      metadata_updated_at: Some(instant),
      metadata_updated_by: Some(Uuid::new_v4()),
      system: DocumentMetadataSystemFacts {
        created_at: instant,
        updated_at: instant,
        created_by: Some(user),
        updated_by: Some(user),
        metadata_updated_at: Some(instant),
        metadata_updated_by: None,
      },
      fields: vec![
        value(
          "version",
          Some(reference(version_id, "unrelated-label-key", "Release B")),
          Some("dirty".into()),
          None,
        ),
        value(
          "status",
          Some(reference(Uuid::new_v4(), "approved", "Approved")),
          Some("published".into()),
          None,
        ),
        value("responsible", None, None, Some(user)),
        value("documentNumber", None, Some("DOC-024".into()), None),
      ],
      audience: vec![
        DocumentMetadataAudience {
          value: reference(Uuid::new_v4(), "b", "Second alphabetically"),
          source: DocumentMetadataSource::Document,
        },
        DocumentMetadataAudience {
          value: reference(Uuid::new_v4(), "a", "First alphabetically"),
          source: DocumentMetadataSource::Document,
        },
      ],
      template: None,
      journal: DocumentMetadataJournal { journal_date: None },
      presentation: None,
      integration: None,
      policy: Default::default(),
    }),
    current_version: Some(DocumentVersion {
      id: version_id,
      doc_id,
      workspace_id,
      doc_history_id: 991,
      version_no: Some(42),
      label: "Release B".into(),
      description: None,
      event: DocumentVersionEvent::Manual,
      kind: DocumentVersionKind::Checkpoint,
      created_by: user,
      created_at: instant,
      updated_by: None,
      updated_at: None,
      is_pinned: false,
      is_protected: false,
      policy_id: None,
      policy_snapshot: serde_json::json!({}),
      content_hash: None,
      metadata: serde_json::json!({}),
    }),
    identities: [(
      user,
      FieldIdentity {
        name: Some("Actual author".into()),
        email: "author@example.test".into(),
      },
    )]
    .into(),
  }
}

fn preferences() -> EffectiveUserPreferences {
  crate::auth::UserPreferences {
    locale: Some("de-DE".into()),
    timezone: Some("Europe/Berlin".into()),
    date_format: Some("year-month-day".into()),
    time_format: Some("24-hour".into()),
    ..Default::default()
  }
  .resolve(&crate::auth::UserPreferenceDefaults::default())
}

fn metadata(key: MetadataKey, format: MetadataFormat) -> DocumentField {
  DocumentField::Metadata {
    id: "occurrence".into(),
    key,
    format,
  }
}

#[test]
fn current_context_uses_authoritative_facts_and_keeps_floating_inputs_distinct() {
  use MetadataFormat as Format;
  use MetadataKey as Key;
  let context = DocumentFieldContext::new(facts(), "content:29".into(), preferences()).unwrap();
  for (key, format, expected) in [
    (Key::Title, Format::Text, "Containing document"),
    (Key::VersionNumber, Format::Text, "42"),
    (Key::VersionLabel, Format::Text, "Release B (geändert)"),
    (Key::Status, Format::Text, "Approved"),
    (Key::DocumentNumber, Format::Text, "DOC-024"),
    (Key::Responsible, Format::Email, "author@example.test"),
    (Key::CreatedBy, Format::Name, "Actual author"),
    (Key::UpdatedBy, Format::Name, "Actual author"),
    (Key::CreatedAt, Format::Date, "2026-11-06"),
    (Key::UpdatedAt, Format::Time, "00:45"),
    (
      Key::Audience,
      Format::Text,
      "Second alphabetically, First alphabetically",
    ),
  ] {
    let presented = context.present(&metadata(key, format)).unwrap();
    assert_eq!(presented.state, FieldValueState::Value, "{key:?}");
    assert_eq!(presented.text.as_deref(), Some(expected), "{key:?}");
  }
  let input: DocumentField = serde_json::from_value(serde_json::json!({
    "type":"input", "id":"date", "definition":{"kind":"date","label":"Due","required":true,"default":"2026-11-07"}, "value":"2026-11-05"
  })).unwrap();
  assert_eq!(context.present(&input).unwrap().text.as_deref(), Some("2026-11-05"));
  let literal: DocumentField = serde_json::from_value(serde_json::json!({
    "type":"input", "id":"answer", "definition":{"kind":"text","label":"Topic","required":true,"default":"Ignored default"}, "value":"  {{literal}}  "
  })).unwrap();
  assert_eq!(
    context.present(&literal).unwrap().text.as_deref(),
    Some("  {{literal}}  ")
  );
}

#[test]
fn missing_facts_stay_explicit_and_profile_changes_invalidate_output_without_metadata_writes() {
  use MetadataFormat as Format;
  use MetadataKey as Key;
  let mut facts = facts();
  let before = DocumentFieldContext::new(facts.clone(), "content:29".into(), preferences()).unwrap();
  facts.identities.values_mut().next().unwrap().name = Some("Renamed author".into());
  let renamed = DocumentFieldContext::new(facts.clone(), "content:29".into(), preferences()).unwrap();
  assert_eq!(
    before.freshness().metadata_projection_version,
    renamed.freshness().metadata_projection_version
  );
  assert_ne!(before.freshness().identity_digest, renamed.freshness().identity_digest);
  assert_eq!(
    renamed
      .present(&metadata(Key::CreatedBy, Format::Name))
      .unwrap()
      .text
      .as_deref(),
    Some("Renamed author")
  );
  let retry_fields = vec![
    DocumentField::Metadata {
      id: "version-label".into(),
      key: Key::VersionLabel,
      format: Format::Text,
    },
    DocumentField::Metadata {
      id: "version-number".into(),
      key: Key::VersionNumber,
      format: Format::Text,
    },
    DocumentField::Metadata {
      id: "author".into(),
      key: Key::CreatedBy,
      format: Format::Name,
    },
  ];
  let original = super::output::PreparedFieldOutput::prepare(&before, &retry_fields).unwrap();
  let renamed_output = super::output::PreparedFieldOutput::prepare(&renamed, &retry_fields).unwrap();
  assert_ne!(
    original.latest_comparison(&retry_fields).unwrap(),
    renamed_output.latest_comparison(&retry_fields).unwrap(),
    "profile changes cannot reuse a previous latest PDF"
  );
  let mut advanced = facts.clone();
  let version = advanced.current_version.as_mut().unwrap();
  version.version_no = Some(43);
  version.label = "Release C".into();
  let projection = advanced.metadata.as_mut().unwrap();
  projection.projection_version.push_str(";new-version-head");
  let field = projection
    .fields
    .iter_mut()
    .find(|field| field.key == "version")
    .unwrap();
  field.reference.as_mut().unwrap().label = "Release C".into();
  field.text_value = Some("show".into());
  let advanced = DocumentFieldContext::new(advanced, "content:29".into(), preferences()).unwrap();
  let advanced_output = super::output::PreparedFieldOutput::prepare(&advanced, &retry_fields).unwrap();
  assert_eq!(
    renamed_output.latest_comparison(&retry_fields).unwrap(),
    advanced_output.latest_comparison(&retry_fields).unwrap(),
    "the export's own version/head update cannot trigger another latest capture"
  );
  facts.identities.clear();
  facts.current_version = None;
  let missing = DocumentFieldContext::new(facts.clone(), "content:29".into(), preferences()).unwrap();
  for field in [
    metadata(Key::CreatedBy, Format::Name),
    metadata(Key::VersionNumber, Format::Text),
  ] {
    let output = missing.present(&field).unwrap();
    assert_eq!(output.state, FieldValueState::Unavailable);
    assert_eq!(output.text, None);
  }
  let version = facts
    .metadata
    .as_mut()
    .unwrap()
    .fields
    .iter_mut()
    .find(|field| field.key == "version")
    .unwrap();
  version.reference = None;
  version.text_value = Some("show".into());
  let initial = DocumentFieldContext::new(facts.clone(), "content:29".into(), preferences()).unwrap();
  assert_eq!(
    initial
      .present(&metadata(Key::VersionNumber, Format::Text))
      .unwrap()
      .state,
    FieldValueState::Unset
  );
  let empty: DocumentField = serde_json::from_value(serde_json::json!({
    "type":"input", "id":"empty", "definition":{"kind":"text","label":"Topic","required":true,"default":"Not an answer"}, "value":null
  })).unwrap();
  let output = initial.present(&empty).unwrap();
  assert_eq!(output.state, FieldValueState::Unset);
  assert_eq!(output.text.as_deref(), Some("Nicht gesetzt"));
  assert!(!output.complete);
  facts.metadata.as_mut().unwrap().doc_id = Uuid::new_v4();
  assert!(matches!(
    DocumentFieldContext::new(facts, "content:29".into(), preferences()),
    Err(DocumentFieldError::ContextUnavailable)
  ));
}

#[test]
fn transient_output_replaces_current_atoms_once_without_mutating_native_or_historical_content() {
  use yrs::{Map, ReadTxn, Text, Transact, updates::decoder::Decode};
  let fields = serde_json::json!({"type":"metadata","id":"status","key":"status","format":"text"});
  let snapshots: Vec<yjs::PortableSnapshotBlock> = serde_json::from_value(serde_json::json!([
    {"id":"page","flavour":"myoxus:page","children":["note"],"props":{"title":"Source title"}},
    {"id":"note","flavour":"myoxus:note","children":["p"]},
    {"id":"p","flavour":"myoxus:paragraph","props":{"text":{"$virgultum:internal:text$":true,"delta":[
      {"insert":"é😀 Before ","attributes":{"italic":true}},
      {"insert":" ","attributes":{"bold":true,"documentField":{"type":"input","id":"answer","definition":{"kind":"text","label":"Question","required":false,"default":"Not the answer"},"value":"Literal {{answer}}"}}},
      {"insert":" · "},
      {"insert":"Forged ","attributes":{"bold":true,"documentField":fields,"documentFieldCaptured":true}},
      {"insert":"status","attributes":{"italic":true,"documentField":fields,"documentFieldCaptured":true}},
      {"insert":" after"}
    ]}}}
  ])).unwrap();
  let snapshot = yjs::snapshot_blocks_to_yjs(&snapshots).unwrap();
  let before = snapshot.clone();
  let context = DocumentFieldContext::new(
    facts(),
    crate::doc::canonical_yjs_revision(&snapshot).unwrap(),
    preferences(),
  )
  .unwrap();
  let output = super::output::current_snapshot(&snapshot, &context).unwrap();
  let raw_diff = crate::document_version::diff_snapshots(&snapshot, &snapshot).unwrap();
  let presented_diff =
    crate::document_version::diff::diff_snapshots_with_current_reading(&snapshot, &snapshot, &output).unwrap();
  assert_eq!(
    presented_diff.state_vector.to_state_vector_sha256, raw_diff.state_vector.to_state_vector_sha256,
    "a transient reading copy cannot change the native state-vector evidence"
  );
  assert!(!presented_diff.state_vector.changed);
  let descriptors = yjs::document_field::content::inspect(&snapshot)
    .unwrap()
    .into_iter()
    .map(|field| field.run.descriptor)
    .collect::<Vec<_>>();
  let prepared = super::output::PreparedFieldOutput::prepare(&context, &descriptors).unwrap();
  let matching_capture = yjs::document_field::content::map(&snapshot, |run| {
    let text = if run.captured {
      // The fixture retains one displayed value across two authored marks.
      if run.text == "Forged " {
        "Appro".to_string()
      } else {
        "ved".to_string()
      }
    } else {
      context.present(&run.descriptor).unwrap().text.unwrap()
    };
    run.reactivate().freeze(text)
  })
  .unwrap()
  .state;
  assert!(
    prepared.matches_frozen(&matching_capture).unwrap(),
    "an export can reuse its actual captured output after its own head change"
  );
  let render_inputs = serde_json::json!({"document_field_output": prepared});
  let deferred = crate::pdf_export::render::document_field_snapshot(
    snapshot.clone(),
    context.freshness().workspace_id,
    context.freshness().doc_id,
    false,
    &render_inputs,
  )
  .unwrap();
  assert_eq!(
    yjs::document_to_snapshot(&deferred, "doc", "Title").unwrap(),
    yjs::document_to_snapshot(&output, "doc", "Title").unwrap(),
    "a deferred serialized render uses the same field text and marks as a current read"
  );
  let renamed_source = yjs::merge_updates(vec![
    snapshot.clone(),
    yjs::update_document_title(&snapshot, "Another source revision").unwrap(),
  ])
  .unwrap();
  assert!(
    crate::pdf_export::render::document_field_snapshot(
      renamed_source,
      context.freshness().workspace_id,
      context.freshness().doc_id,
      false,
      &render_inputs
    )
    .is_err(),
    "a later source cannot consume a captured output plan"
  );
  assert!(
    crate::pdf_export::render::document_field_snapshot(
      snapshot.clone(),
      context.freshness().workspace_id,
      context.freshness().doc_id,
      true,
      &render_inputs
    )
    .is_err(),
    "a live plan cannot refresh a historical atom"
  );
  let stale = DocumentFieldContext::new(facts(), "another content capture".into(), preferences()).unwrap();
  assert!(matches!(
    super::output::current_snapshot(&snapshot, &stale),
    Err(DocumentFieldError::ContextUnavailable)
  ));
  assert!(
    yjs::document_field::content::inspect(&output).unwrap().is_empty(),
    "readers receive literal display text, never native embed tokens"
  );
  let doc = yrs::Doc::new();
  doc
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(&output).unwrap())
    .unwrap();
  let txn = doc.transact();
  let yrs::Out::YMap(block) = txn.get_map("blocks").unwrap().get(&txn, "p").unwrap() else {
    panic!("paragraph")
  };
  let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
    panic!("text")
  };
  use yrs::GetString;
  assert_eq!(text.get_string(&txn), "é😀 Before Literal {{answer}} · Approved after");
  let runs = text.diff(&txn, |_| ());
  assert_eq!(
    runs[0].attributes.as_ref().unwrap().get("italic"),
    Some(&yrs::Any::Bool(true))
  );
  assert_eq!(snapshot, before);
  let workspace_id = context.freshness().workspace_id;
  let doc_id = context.freshness().doc_id;
  let service = crate::doc::DocumentContentProjectionService::new(
    crate::doc::DocService::new(std::sync::Arc::new(crate::doc::PanicDocStore)).load,
    Vec::<u8>::new(),
  )
  .with_field_context(std::sync::Arc::new(context));
  let projected = service
    .project_payload(
      crate::doc::DocumentProjectionRequest {
        workspace_id,
        doc_id,
        fallback_title: "Source title".into(),
        metadata_badges: Vec::new(),
        representation: crate::doc::DocumentRepresentation::Structured,
        cursor: None,
        limit: None,
        theme_css_url: String::new(),
        selector: None,
        neighbor_context: 0,
      },
      &snapshot,
      29,
    )
    .unwrap();
  let crate::doc::DocumentContentProjection::Structured(projected) = projected else {
    panic!("structured output")
  };
  let paragraph = projected
    .document
    .blocks
    .iter()
    .find(|block| block.block_id() == "p")
    .unwrap();
  let myoxus_public_render::Block::Paragraph { text, .. } = paragraph else {
    panic!("display paragraph")
  };
  assert_eq!(
    text.iter().map(|part| part.text.as_str()).collect::<String>(),
    "é😀 Before Literal {{answer}} · Approved after"
  );
  let native = &projected.document.native_text["p"].fields[0];
  assert!(
    native.length < text.iter().map(|part| part.text.len() as u32).sum::<u32>(),
    "edit offsets retain one native space, not the expanded answer width"
  );
  assert_eq!(
    native.spans.iter().filter(|span| span.document_field.is_some()).count(),
    3
  );
  assert!(
    super::output::historical_snapshot(&snapshot).is_err(),
    "historical readers cannot resolve a live atom from today's context"
  );
  let captured = yjs::document_field::content::map(&snapshot, |run| {
    if run.captured {
      Ok(run.clone())
    } else {
      run.freeze("Captured old answer".into())
    }
  })
  .unwrap()
  .state;
  assert_eq!(super::output::historical_snapshot(&captured).unwrap(), captured);
  let historical = crate::doc::DocumentContentProjectionService::new(
    crate::doc::DocService::new(std::sync::Arc::new(crate::doc::PanicDocStore)).load,
    Vec::<u8>::new(),
  )
  .with_html_catalog(Some(std::sync::Arc::new({
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
    let files = myoxus_public_render::HTML_CATALOG_FILES
      .iter()
      .map(|name| (name.to_string(), std::fs::read(root.join(name)).unwrap()))
      .collect();
    myoxus_public_render::HtmlRenderer::from_files(files).unwrap()
  })))
  .with_historical_fields();
  for representation in [
    crate::doc::DocumentRepresentation::Html,
    crate::doc::DocumentRepresentation::Markdown,
    crate::doc::DocumentRepresentation::PlainText,
  ] {
    let request = crate::doc::DocumentProjectionRequest {
      workspace_id,
      doc_id,
      fallback_title: "Source title".into(),
      metadata_badges: Vec::new(),
      representation,
      cursor: None,
      limit: None,
      theme_css_url: String::new(),
      selector: None,
      neighbor_context: 0,
    };
    let crate::doc::DocumentContentProjection::Export(result) =
      historical.project_payload(request.clone(), &captured, 29).unwrap()
    else {
      panic!("historical export")
    };
    assert!(
      result.data.contains("Captured old answer"),
      "missing immutable input in {representation:?}"
    );
    assert!(
      result.data.contains("Forged") && result.data.contains("status"),
      "missing captured formatted runs in {representation:?}"
    );
    assert!(
      !result.data.contains("Approved"),
      "historical export must not resolve current metadata"
    );
    assert!(
      historical.project_payload(request, &snapshot, 29).is_err(),
      "uncaptured history must fail explicitly"
    );
    if representation == crate::doc::DocumentRepresentation::Markdown {
      let imported = crate::markdown::prepare_markdown_import("Imported", &result.data).unwrap();
      assert!(
        yjs::document_field::content::inspect(&imported.yjs_binary)
          .unwrap()
          .is_empty(),
        "ordinary Markdown import is literal rather than a revived field"
      );
    }
  }
  assert!(
    !serde_json::from_value::<super::output::PreparedFieldOutput>(render_inputs["document_field_output"].clone())
      .unwrap()
      .matches_frozen(&captured)
      .unwrap(),
    "a broad latest retry key cannot reuse differently displayed historical fields"
  );
  assert_eq!(
    crate::pdf_export::render::document_field_snapshot(captured.clone(), workspace_id, doc_id, true, &render_inputs)
      .unwrap(),
    captured,
    "historical PDF output ignores current render-plan values"
  );
}
