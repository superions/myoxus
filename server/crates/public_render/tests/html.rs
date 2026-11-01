use chrono::{TimeZone, Utc};
use myoxus_public_render::{
  AssetRef, Block, CalloutAppearance, Document, DocumentBadge, HtmlRenderOptions, InlineText, PublicBreadcrumb,
  PublicDocIr, PublicSiteShellOptions, SocialCardInput, WorkspaceIndex, WorkspaceIndexItem, apply_public_asset_url,
  document_from_yjs, render_document_html, render_social_card_png, render_workspace_index_html,
  resolve_asset_candidates,
};
use uuid::Uuid;
use yrs::{Array, Doc, Map, Transact};

fn options() -> HtmlRenderOptions {
  HtmlRenderOptions {
    canonical_url: "https://example.test/public/ws/doc".to_string(),
    theme_css_url: "/api/branding/theme.css".to_string(),
    favicon_url: "/favicon.ico".to_string(),
    noindex: false,
    locale: "en".to_string(),
    snapshot_relative_links: false,
    site_shell: PublicSiteShellOptions::default(),
  }
}

#[test]
fn native_math_reading_projection_retains_formula_source_without_a_renderer_runtime() {
  let source = "Energy $E=mc^2$.\n\n$$\n\\frac{a}{b}\n$$\n\n%%Hidden $annotation$%%";
  let update = yjs::markdown_to_yjs("Math", source).unwrap();
  let ir = document_from_yjs(Uuid::new_v4(), Uuid::new_v4(), "Math", "page", &update).unwrap();
  let output = render_document_html(&renderer(), &ir, &options()).unwrap();
  assert!(output.html.contains("<code>E=mc^2</code>"));
  // Syntax highlighting may split the source across spans; assert visible text
  // rather than requiring contiguous bytes in its HTML representation.
  let text: String = output
    .html
    .split('<')
    .filter_map(|part| part.split_once('>').map(|(_, text)| text))
    .collect();
  assert!(text.contains("\\frac{a}{b}"));
  assert!(!output.html.contains("Hidden"));
}

#[test]
fn workspace_index_uses_external_routes_and_escapes_visible_content_once() {
  let workspace_id = Uuid::new_v4();
  let internal_id = Uuid::new_v4();
  let description = "First line <script>alert('x')</script>\nSecond & final line";
  let index = WorkspaceIndex {
    document_count: 1,
    register_columns: vec!["title".into(), "updatedAt".into()],
    workspace_id,
    title: "Research <Lab>".to_string(),
    description: description.to_string(),
    items: vec![WorkspaceIndexItem {
      register: std::collections::BTreeMap::from([(
        "updatedAt".into(),
        myoxus_public_render::WorkspaceRegisterValue::Timestamp(Utc.with_ymd_and_hms(2026, 9, 20, 12, 0, 0).unwrap()),
      )]),
      href: None,
      doc_id: internal_id,
      route_key: "release-notes-42".to_string(),
      title: "Roadmap <Q4>".to_string(),
      public_mode: "Page".to_string(),
    }],
    ..Default::default()
  };

  let output = render_workspace_index_html(&renderer(), &index, &options()).expect("render workspace index");

  assert!(output.html.contains("<h1>Research &lt;Lab&gt;</h1>"));
  assert!(
    output
      .html
      .contains("First line &lt;script&gt;alert(&#x27;x&#x27;)&lt;&#x2f;script&gt;\nSecond &amp; final line")
  );
  assert!(
    output
      .html
      .contains(&format!("href=\"/public/{workspace_id}/release-notes-42\""))
  );
  assert!(!output.html.contains(&internal_id.to_string()));
  assert!(output.html.contains("<h2>Published documents</h2>"));
  assert!(output.html.contains(">1 document<"));
  assert!(output.html.contains("September 20, 2026, 12:00 UTC"));
  assert!(!output.html.contains("<nav class=\"mx-public-breadcrumbs\""));
  assert!(!output.html.contains("<aside class=\"mx-public-aside\""));
  assert_eq!(
    output.seo.description,
    description.split_whitespace().collect::<Vec<_>>().join(" ")
  );
}

#[test]
fn workspace_index_localizes_empty_state_and_truncates_only_seo_description() {
  let description = "ä".repeat(200);
  let index = WorkspaceIndex {
    register_columns: vec!["title".into(), "updatedAt".into()],
    workspace_id: Uuid::new_v4(),
    title: "Leerer Workspace".to_string(),
    document_count: 0,
    description: description.clone(),
    items: Vec::new(),
    ..Default::default()
  };
  let mut render_options = options();
  render_options.locale = "de-DE".to_string();

  let output = render_workspace_index_html(&renderer(), &index, &render_options).expect("render empty workspace index");

  assert!(output.html.contains("<html lang=\"de-DE\""));
  assert!(output.html.contains("Veröffentlichte Dokumente"));
  assert!(output.html.contains("0 Dokumente"));
  let german: serde_json::Value = serde_json::from_str(include_str!("../../../templates/html/i18n/de.json")).unwrap();
  assert!(output.html.contains(german["no_documents"].as_str().unwrap()));
  assert!(output.html.contains(&description));
  assert_eq!(output.seo.description.chars().count(), 183);
  assert!(output.seo.description.ends_with("..."));
}

#[test]
fn workspace_index_snapshot_links_resolve_from_emitted_index() {
  let index = WorkspaceIndex {
    document_count: 1,
    register_columns: vec!["title".into(), "updatedAt".into()],
    workspace_id: Uuid::new_v4(),
    title: "Offline workspace".to_string(),
    description: String::new(),
    items: vec![WorkspaceIndexItem {
      register: std::collections::BTreeMap::from([(
        "updatedAt".into(),
        myoxus_public_render::WorkspaceRegisterValue::Timestamp(Utc::now()),
      )]),
      href: None,
      doc_id: Uuid::new_v4(),
      route_key: "offline-document".to_string(),
      title: "Offline document".to_string(),
      public_mode: "Page".to_string(),
    }],
    ..Default::default()
  };
  let mut render_options = options();
  render_options.snapshot_relative_links = true;

  let output =
    render_workspace_index_html(&renderer(), &index, &render_options).expect("render snapshot workspace index");

  assert!(output.html.contains("href=\"index.html\""));
  assert!(output.html.contains("href=\"offline-document/index.html\""));
  assert!(!output.html.contains(&format!("href=\"/public/{}/", index.workspace_id)));
}

fn active_editor_list_payload() -> Vec<u8> {
  fn create_block(
    blocks: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    id: &str,
    flavour: &str,
  ) -> (yrs::MapRef, yrs::ArrayRef) {
    let block = blocks.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:version", 1.0);
    let children = block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
    (block, children)
  }

  fn create_list(
    blocks: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    id: &str,
    list_type: &str,
    text: &str,
    checked: bool,
  ) -> yrs::ArrayRef {
    let (block, children) = create_block(blocks, txn, id, "myoxus:list");
    block.insert(txn, "prop:type", list_type);
    block.insert(txn, "prop:text", yrs::TextPrelim::new(text));
    block.insert(txn, "prop:checked", checked);
    children
  }

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let (page, page_children) = create_block(&blocks, &mut txn, "page", "myoxus:page");
  page.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Public lists"));
  let (_note, note_children) = create_block(&blocks, &mut txn, "note", "myoxus:note");
  page_children.push_back(&mut txn, "note");

  let first_bullet_children = create_list(&blocks, &mut txn, "bullet-one", "bulleted", "First bullet", false);
  create_list(&blocks, &mut txn, "nested-bullet", "bulleted", "Nested bullet", false);
  first_bullet_children.push_back(&mut txn, "nested-bullet");
  create_list(&blocks, &mut txn, "bullet-two", "bulleted", "Second bullet", false);
  create_list(&blocks, &mut txn, "number-one", "numbered", "First number", false);
  create_list(&blocks, &mut txn, "todo-open", "todo", "Open task", false);
  create_list(&blocks, &mut txn, "todo-done", "todo", "Done task", true);

  for id in ["bullet-one", "bullet-two", "number-one", "todo-open", "todo-done"] {
    note_children.push_back(&mut txn, id);
  }
  txn.encode_update_v1()
}

fn active_editor_mermaid_payload() -> Vec<u8> {
  fn create_block(
    blocks: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    id: &str,
    flavour: &str,
  ) -> (yrs::MapRef, yrs::ArrayRef) {
    let block = blocks.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:version", 1.0);
    let children = block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
    (block, children)
  }

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let (page, page_children) = create_block(&blocks, &mut txn, "page", "myoxus:page");
  page.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Public Mermaid"));
  let (_note, note_children) = create_block(&blocks, &mut txn, "note", "myoxus:note");
  page_children.push_back(&mut txn, "note");
  let (mermaid, _mermaid_children) = create_block(&blocks, &mut txn, "diagram", "myoxus:mermaid");
  mermaid.insert(
    &mut txn,
    "prop:source",
    yrs::TextPrelim::new("flowchart TD\n  A[Start] --> B[Done]"),
  );
  mermaid.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Release flow"));
  mermaid.insert(&mut txn, "prop:caption", "Rendered from the canonical Mermaid block");
  note_children.push_back(&mut txn, "diagram");
  txn.encode_update_v1()
}

fn active_editor_callout_payload(appearance: Option<&str>) -> Vec<u8> {
  fn create_block(
    blocks: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    id: &str,
    flavour: &str,
  ) -> (yrs::MapRef, yrs::ArrayRef) {
    let block = blocks.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:version", 1.0);
    let children = block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
    (block, children)
  }

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let (page, page_children) = create_block(&blocks, &mut txn, "page", "myoxus:page");
  page.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Public callout"));
  let (_note, note_children) = create_block(&blocks, &mut txn, "note", "myoxus:note");
  let (callout, callout_children) = create_block(&blocks, &mut txn, "callout", "myoxus:callout");
  let (paragraph, _paragraph_children) = create_block(&blocks, &mut txn, "paragraph", "myoxus:paragraph");
  let (bullet, _bullet_children) = create_block(&blocks, &mut txn, "bullet", "myoxus:list");
  let (numbered, _numbered_children) = create_block(&blocks, &mut txn, "numbered", "myoxus:list");
  let (todo, _todo_children) = create_block(&blocks, &mut txn, "todo", "myoxus:list");

  callout.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Callout own text"));
  if let Some(appearance) = appearance {
    callout.insert(&mut txn, "prop:appearance", appearance);
  }
  paragraph.insert(&mut txn, "prop:type", "text");
  paragraph.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Paragraph child"));
  bullet.insert(&mut txn, "prop:type", "bulleted");
  bullet.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Bullet child"));
  numbered.insert(&mut txn, "prop:type", "numbered");
  numbered.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Numbered child"));
  todo.insert(&mut txn, "prop:type", "todo");
  todo.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Todo child"));
  todo.insert(&mut txn, "prop:checked", true);

  page_children.push_back(&mut txn, "note");
  note_children.push_back(&mut txn, "callout");
  for id in ["paragraph", "bullet", "numbered", "todo"] {
    callout_children.push_back(&mut txn, id);
  }
  txn.encode_update_v1()
}

fn active_editor_table_payload(header_rows: Option<f64>, appearance: Option<&str>, density: Option<&str>) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let create = |txn: &mut yrs::TransactionMut<'_>, id: &str, flavour: &str| {
    let block = blocks.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:children", yrs::ArrayPrelim::default())
  };
  let page_children = create(&mut txn, "page", "myoxus:page");
  let note_children = create(&mut txn, "note", "myoxus:note");
  let _table_children = create(&mut txn, "table", "myoxus:table");
  page_children.push_back(&mut txn, "note");
  note_children.push_back(&mut txn, "table");
  let table = blocks
    .get(&txn, "table")
    .and_then(|value| match value {
      yrs::Out::YMap(table) => Some(table),
      _ => None,
    })
    .expect("table map");
  if let Some(header_rows) = header_rows {
    table.insert(&mut txn, "prop:headerRows", header_rows);
  }
  if let Some(appearance) = appearance {
    table.insert(&mut txn, "prop:appearance", appearance);
  }
  if let Some(density) = density {
    table.insert(&mut txn, "prop:density", density);
  }
  table.insert(&mut txn, "prop:columns.c.columnId", "c");
  table.insert(&mut txn, "prop:columns.c.order", "a0");
  for (row_id, order, text) in [
    ("r1", "a0", "Header one"),
    ("r2", "a1", "Header two"),
    ("r3", "a2", "Body"),
  ] {
    table.insert(&mut txn, format!("prop:rows.{row_id}.rowId"), row_id);
    table.insert(&mut txn, format!("prop:rows.{row_id}.order"), order);
    table.insert(
      &mut txn,
      format!("prop:cells.{row_id}:c.text"),
      yrs::TextPrelim::new(text),
    );
  }
  txn.encode_update_v1()
}

fn active_editor_unsupported_payload() -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let make = |txn: &mut yrs::TransactionMut<'_>, id: &str, flavour: &str| {
    let block = blocks.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:children", yrs::ArrayPrelim::default())
  };
  let page_children = make(&mut txn, "page", "myoxus:page");
  let note_children = make(&mut txn, "note", "myoxus:note");
  make(&mut txn, "unsupported", "myoxus:future-widget");
  page_children.push_back(&mut txn, "note");
  note_children.push_back(&mut txn, "unsupported");
  txn.encode_update_v1()
}

#[test]
fn public_html_escapes_text_and_raw_html() {
  let ir = PublicDocIr {
    native_children: Default::default(),
    native_tables: Default::default(),
    mutation_partial: false,
    native_citations: Default::default(),
    native_text: Default::default(),
    document: Document {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      title: "Title <script>".to_string(),
      public_mode: "Page".to_string(),
      metadata_badges: vec![],
      blocks: vec![Block::Paragraph {
        block_id: "paragraph".to_string(),
        text: vec![InlineText::plain("<img src=x onerror=alert(1)>")],
      }],
      assets: vec![],
    },
    diagnostics: vec![],
  };
  let html = render_document_html(&renderer(), &ir, &options()).expect("render").html;
  assert!(html.contains("href=\"/api/branding/theme.css\""));
  assert!(html.contains("data-myoxus-role=\"public-header\""));
  assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
  assert!(!html.contains("<img src=x"));
  assert!(!html.contains("<script>"));
}

#[test]
fn public_html_distinguishes_legacy_and_explicit_table_header_rows() {
  for (header_rows, expected_ir, expected_headers) in [
    (None, None, 1),
    (Some(0.0), Some(0), 0),
    (Some(1.0), Some(1), 1),
    (Some(2.0), Some(2), 2),
  ] {
    let ir = document_from_yjs(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Table",
      "Page",
      &active_editor_table_payload(header_rows, None, None),
    )
    .expect("table IR");
    let Block::Table {
      header_rows: actual, ..
    } = &ir.document.blocks[0]
    else {
      panic!("expected table block")
    };
    assert_eq!(*actual, expected_ir);
    let html = render_document_html(&renderer(), &ir, &options())
      .expect("table HTML")
      .html;
    assert_eq!(html.matches("<th scope=\"col\">").count(), expected_headers);
    assert_eq!(html.matches("<td>").count(), 3 - expected_headers);
    assert_eq!(html.contains("<thead>"), expected_headers > 0);
  }
}

#[test]
fn public_html_projects_table_appearance_and_density_semantics() {
  for (appearance, density) in [
    ("grid", "normal"),
    ("grid", "compact"),
    ("ruled", "normal"),
    ("ruled", "compact"),
    ("plain", "normal"),
    ("plain", "compact"),
  ] {
    let ir = document_from_yjs(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Table",
      "Page",
      &active_editor_table_payload(Some(1.0), Some(appearance), Some(density)),
    )
    .expect("table IR");
    let html = render_document_html(&renderer(), &ir, &options())
      .expect("table HTML")
      .html;
    assert!(html.contains(&format!("mx-public-table--{appearance}")));
    assert!(html.contains(&format!("mx-public-table--{density}")));
    assert!(html.contains(&format!("data-appearance=\"{appearance}\"")));
    assert!(html.contains(&format!("data-density=\"{density}\"")));
  }

  let legacy = document_from_yjs(
    Uuid::new_v4(),
    Uuid::new_v4(),
    "Legacy table",
    "Page",
    &active_editor_table_payload(None, Some("future"), Some("dense")),
  )
  .expect("legacy table IR");
  let html = render_document_html(&renderer(), &legacy, &options())
    .expect("legacy table HTML")
    .html;
  assert!(html.contains("mx-public-table--grid mx-public-table--normal"));
}

#[test]
fn public_html_projects_callout_text_children_and_appearance() {
  for (source, expected) in [
    (None, CalloutAppearance::Soft),
    (Some("soft"), CalloutAppearance::Soft),
    (Some("accent"), CalloutAppearance::Accent),
    (Some("outline"), CalloutAppearance::Outline),
    (Some("future"), CalloutAppearance::Soft),
  ] {
    let ir = document_from_yjs(
      Uuid::new_v4(),
      Uuid::new_v4(),
      "Callout",
      "Page",
      &active_editor_callout_payload(source),
    )
    .expect("callout IR");
    let Block::Callout {
      text,
      appearance,
      children,
      ..
    } = &ir.document.blocks[0]
    else {
      panic!("expected callout block")
    };
    assert_eq!(*appearance, expected);
    assert_eq!(
      text.iter().map(|span| span.text.as_str()).collect::<String>(),
      "Callout own text"
    );
    assert_eq!(children.len(), 4);
    assert!(
      !ir
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "unsupported_block")
    );

    let html = render_document_html(&renderer(), &ir, &options())
      .expect("callout HTML")
      .html;
    let expected_name = match expected {
      CalloutAppearance::Soft => "soft",
      CalloutAppearance::Accent => "accent",
      CalloutAppearance::Outline => "outline",
    };
    assert!(html.contains("data-myoxus-role=\"public-callout\""));
    assert!(html.contains(&format!("data-appearance=\"{expected_name}\"")));
    assert!(html.contains("<p class=\"mx-public-callout-text\">Callout own text</p><p>Paragraph child</p>"));
    assert!(html.contains("data-list-type=\"bulleted\""));
    assert!(html.contains("data-list-type=\"numbered\""));
    assert!(html.contains("data-list-type=\"todo\""));
    assert!(html.contains("type=\"checkbox\" disabled checked"));

    let positions = [
      "Callout own text",
      "Paragraph child",
      "Bullet child",
      "Numbered child",
      "Todo child",
    ]
    .map(|needle| html.find(needle).expect("callout content in HTML"));
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
  }
}

#[test]
fn public_html_renders_title_badges_and_mermaid_as_validated_svg() {
  let mut ir = document_from_yjs(
    Uuid::new_v4(),
    Uuid::new_v4(),
    "Fallback",
    "Page",
    &active_editor_mermaid_payload(),
  )
  .expect("public Mermaid IR");
  ir.document.metadata_badges = vec![
    DocumentBadge {
      key: "status".to_string(),
      label: "Status".to_string(),
      value: "Published".to_string(),
    },
    DocumentBadge {
      key: "classification".to_string(),
      label: "Classification".to_string(),
      value: "Public".to_string(),
    },
  ];

  let html = render_document_html(&renderer(), &ir, &options())
    .expect("render public Mermaid")
    .html;

  assert!(html.contains("data-myoxus-role=\"public-document-metadata\""));
  assert!(html.contains("data-metadata-key=\"status\""));
  assert!(html.contains("<dt>Status</dt>"));
  assert!(html.contains("<dd>Published</dd>"));
  assert!(html.contains("data-myoxus-role=\"public-mermaid\""));
  assert!(html.contains("data-render-status=\"rendered\""));
  assert!(html.contains("<svg"));
  assert!(html.contains("Start"));
  assert!(html.contains("Done"));
  assert!(html.contains("<strong>Release flow</strong>"));
  assert!(html.contains("Rendered from the canonical Mermaid block"));
  assert!(!html.contains("Unsupported block:"));
  assert!(!html.contains("myoxus:mermaid"));
}

#[test]
fn unsupported_active_blocks_remain_visible_in_ir_json_and_html() {
  let ir = document_from_yjs(
    Uuid::new_v4(),
    Uuid::new_v4(),
    "Unsupported fixture",
    "Page",
    &active_editor_unsupported_payload(),
  )
  .expect("project unsupported fixture");
  let unsupported = ir
    .diagnostics
    .iter()
    .find(|diagnostic| diagnostic.code == "unsupported_block")
    .expect("unsupported block diagnostic");
  assert_eq!(unsupported.block_id.as_deref(), Some("unsupported"));
  assert!(
    ir.diagnostics
      .iter()
      .any(|diagnostic| diagnostic.code == "partial_yjs_extraction")
  );
  let block = serde_json::to_value(&ir.document.blocks[0]).expect("serialize unsupported block");
  assert_eq!(block["kind"], "unsupported_block");
  assert_eq!(block["blockId"], "unsupported");
  let html = render_document_html(&renderer(), &ir, &options())
    .expect("render unsupported fixture")
    .html;
  assert!(html.contains("data-myoxus-role=\"public-unsupported\""));
}

#[test]
fn public_css_uses_server_theme_projection_tokens() {
  for needle in [
    "--myoxus-sem-surface-page",
    "--myoxus-sem-text-primary",
    "--myoxus-sem-link-default",
    "--myoxus-typography-body-family",
    "--myoxus-typography-h1-family",
    "--myoxus-typography-mono-family",
    "--myoxus-background-code-block",
  ] {
    assert!(
      renderer().public_css().contains(needle),
      "public CSS should contain `{needle}`"
    );
  }

  assert_eq!(
    renderer()
      .public_css()
      .matches("background: var(--myoxus-background-code-block)")
      .count(),
    3,
    "block code, inline code and the code header must share the canonical theme surface"
  );

  for forbidden in [
    "Canvas",
    "CanvasText",
    "LinkText",
    "Highlight",
    "color-mix(",
    "--myoxus-color-",
  ] {
    assert!(
      !renderer().public_css().contains(forbidden),
      "public CSS must not use browser or legacy color fallback `{forbidden}`"
    );
  }
}

#[test]
fn public_html_rejects_javascript_links_and_keeps_external_rel() {
  let ir = PublicDocIr {
    native_children: Default::default(),
    native_tables: Default::default(),
    mutation_partial: false,
    native_citations: Default::default(),
    native_text: Default::default(),
    document: Document {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      title: "Links".to_string(),
      public_mode: "Page".to_string(),
      metadata_badges: vec![],
      blocks: vec![
        Block::BookmarkCard {
          block_id: "bad-link".to_string(),
          url: "javascript:alert(1)".to_string(),
          title: "bad".to_string(),
        },
        Block::BookmarkCard {
          block_id: "good-link".to_string(),
          url: "https://example.org".to_string(),
          title: "good".to_string(),
        },
      ],
      assets: vec![],
    },
    diagnostics: vec![],
  };
  let html = render_document_html(&renderer(), &ir, &options()).expect("render").html;
  assert!(!html.contains("javascript:alert"));
  assert!(html.contains("rel=\"noopener noreferrer\""));
}

#[test]
fn public_html_uses_public_asset_urls() {
  let ir = PublicDocIr {
    native_children: Default::default(),
    native_tables: Default::default(),
    mutation_partial: false,
    native_citations: Default::default(),
    native_text: Default::default(),
    document: Document {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      title: "Images".to_string(),
      public_mode: "Page".to_string(),
      metadata_badges: vec![],
      blocks: vec![Block::Image {
        block_id: "image".to_string(),
        asset: AssetRef {
          source: "private/blob.png".to_string(),
          alt: "Blob".to_string(),
          public_url: Some("/public-assets/ws/doc/hash/blob.png".to_string()),
        },
      }],
      assets: vec![],
    },
    diagnostics: vec![],
  };
  let html = render_document_html(&renderer(), &ir, &options()).expect("render").html;
  assert!(html.contains("/public-assets/ws/doc/hash/blob.png"));
  assert!(!html.contains("private/blob.png"));
}

#[test]
fn public_ir_detects_yjs_projected_image_assets() {
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let payload = yjs::markdown_to_yjs("Image", "![Alt text](public-image.png)").expect("fixture yjs");
  let ir = document_from_yjs(workspace_id, doc_id, "Image", "Page", &payload).expect("public ir");
  let candidates = resolve_asset_candidates(&ir);
  assert_eq!(candidates.len(), 1);
  assert_eq!(candidates[0].blob_key, "public-image.png");
  assert_eq!(
    ir.document.assets.first().map(|asset| asset.alt.as_str()),
    Some("Alt text")
  );
}

#[test]
fn public_asset_candidates_dedupe_repeated_blob_sources() {
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let payload = yjs::markdown_to_yjs(
    "Repeated image",
    "![First](markdown-import/doc/repeated.svg)\n\n![Second](markdown-import/doc/repeated.svg)",
  )
  .expect("fixture yjs");
  let ir = document_from_yjs(workspace_id, doc_id, "Repeated image", "Page", &payload).expect("public ir");

  let candidates = resolve_asset_candidates(&ir);

  assert_eq!(candidates.len(), 1);
  assert_eq!(candidates[0].blob_key, "markdown-import/doc/repeated.svg");
}

#[test]
fn public_html_renders_seed_like_yjs_semantics_without_markdown_projection() {
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  let image_key = format!("markdown-import/{doc_id}/probe.svg");
  let markdown = format!(
    "# Editor Typography Stress Document\n\n\
     ## Image and Table Section\n\n\
     Rendered **bold**, *italic*, ~~strike~~, `inline code`, and [link](https://example.test).\n\n\
     | Column | Expected Behavior |\n\
     | --- | --- |\n\
     | Images | SVG and PNG render through public assets |\n\n\
     ![SVG layout probe]({image_key})\n\n\
     #### Deep Heading\n"
  );
  let payload = yjs::markdown_to_yjs("Editor Typography Stress Document", &markdown).expect("fixture yjs");
  let mut ir = document_from_yjs(workspace_id, doc_id, "Fallback", "Page", &payload).expect("public ir");

  apply_public_asset_url(&mut ir, &image_key, "/public-assets/ws/doc/hash/probe.svg");
  let html = render_document_html(&renderer(), &ir, &options()).expect("render").html;

  assert!(html.contains("<h1 id=\"editor-typography-stress-document\">"));
  assert!(html.contains("<h2 id=\"image-and-table-section\">"));
  assert!(html.contains("<h4 id=\"deep-heading\">"));
  assert!(html.contains("<strong>bold</strong>"));
  assert!(html.contains("<em>italic</em>"));
  assert!(html.contains("<del>strike</del>"));
  assert!(html.contains("<code>inline code</code>"));
  assert!(html.contains("href=\"https://example.test\" rel=\"noopener noreferrer\""));
  assert!(html.contains("data-myoxus-role=\"public-table\""));
  assert!(html.contains("<th scope=\"col\">Column</th>"));
  assert!(html.contains("<td>Images</td>"));
  assert!(html.contains("/public-assets/ws/doc/hash/probe.svg"));
  assert!(!html.contains("<p>| Column |"));
  assert!(!html.contains("**bold**"));
}

#[test]
fn public_html_preserves_editor_list_types_groups_and_nesting() {
  let ir = document_from_yjs(
    Uuid::new_v4(),
    Uuid::new_v4(),
    "Fallback",
    "Page",
    &active_editor_list_payload(),
  )
  .expect("public list ir");

  let html = render_document_html(&renderer(), &ir, &options())
    .expect("render public lists")
    .html;

  assert_eq!(html.matches("data-list-type=\"bulleted\"").count(), 2);
  assert_eq!(html.matches("data-list-type=\"numbered\"").count(), 1);
  assert_eq!(html.matches("data-list-type=\"todo\"").count(), 1);
  assert_eq!(html.matches("type=\"checkbox\"").count(), 2);
  assert_eq!(html.matches("type=\"checkbox\" disabled checked").count(), 1);
  assert!(html.contains(
    "<li data-myoxus-role=\"public-list-item\">First bullet<ul class=\"mx-public-list mx-public-list--bulleted\""
  ));
  assert!(html.contains("Nested bullet</li></ul></li><li data-myoxus-role=\"public-list-item\">Second bullet"));
  assert!(html.contains("<ol class=\"mx-public-list mx-public-list--numbered\""));
  assert!(html.contains(">First number</li></ol>"));
  assert!(!html.contains("<input type=\"checkbox\" disabled /><span>First bullet</span>"));
  assert!(!html.contains("<input type=\"checkbox\" disabled /><span>First number</span>"));
}

#[test]
fn public_html_renders_toc_breadcrumbs_and_copyable_highlighted_code() {
  let mut options = options();
  options.site_shell.breadcrumbs = vec![
    PublicBreadcrumb {
      label: "Workspace".to_string(),
      href: Some("/public/workspace".to_string()),
    },
    PublicBreadcrumb {
      label: "Document".to_string(),
      href: None,
    },
  ];
  let ir = PublicDocIr {
    native_children: Default::default(),
    native_tables: Default::default(),
    mutation_partial: false,
    native_citations: Default::default(),
    native_text: Default::default(),
    document: Document {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      title: "Developer Guide".to_string(),
      public_mode: "Page".to_string(),
      metadata_badges: vec![],
      blocks: vec![
        Block::Heading {
          block_id: "heading".to_string(),
          level: 2,
          text: vec![InlineText::plain("Setup & Usage")],
        },
        Block::Code {
          native_latex: false,
          block_id: "code".to_string(),
          language: Some("rust".to_string()),
          text: "fn main() { println!(\"safe\"); }".to_string(),
        },
      ],
      assets: vec![],
    },
    diagnostics: vec![],
  };

  let html = render_document_html(&renderer(), &ir, &options).expect("render");

  assert!(html.html.contains("mx-public-breadcrumbs"));
  assert!(html.html.contains("href=\"#setup-usage\""));
  assert!(html.html.contains("data-myoxus-public-copy"));
  assert!(html.html.contains("mx-public-code-language"));
  assert!(html.html.contains("language-rust"));
  assert!(html.html.contains("<span style="));
  assert_eq!(html.html.matches("<pre").count(), 1);
  assert!(!html.html.contains("<code class=\"language-rust\"><pre"));
  assert!(!html.html.contains("fn main() { println!(\"safe\"); }"));
}

#[test]
fn public_html_unknown_code_language_falls_back_to_escaped_plain_code() {
  let ir = PublicDocIr {
    native_children: Default::default(),
    native_tables: Default::default(),
    mutation_partial: false,
    native_citations: Default::default(),
    native_text: Default::default(),
    document: Document {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      title: "Code".to_string(),
      public_mode: "Page".to_string(),
      metadata_badges: vec![],
      blocks: vec![Block::Code {
        native_latex: false,
        block_id: "code".to_string(),
        language: Some("unknown-language".to_string()),
        text: "<script>alert(1)</script>".to_string(),
      }],
      assets: vec![],
    },
    diagnostics: vec![],
  };

  let html = render_document_html(&renderer(), &ir, &options()).expect("render").html;

  assert!(html.contains("&lt;script&gt;alert(1)"));
  assert!(!html.contains("<script>alert"));
}

#[test]
fn public_html_loads_pagefind_as_module_when_search_bundle_is_configured() {
  let mut options = options();
  options.site_shell.search_bundle_url = Some("/public-search/pagefind/pagefind.js".to_string());
  let ir = PublicDocIr {
    native_children: Default::default(),
    native_tables: Default::default(),
    mutation_partial: false,
    native_citations: Default::default(),
    native_text: Default::default(),
    document: Document {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      title: "Search".to_string(),
      public_mode: "Page".to_string(),
      metadata_badges: vec![],
      blocks: vec![Block::Paragraph {
        block_id: "paragraph".to_string(),
        text: vec![InlineText::plain("Searchable public documentation")],
      }],
      assets: vec![],
    },
    diagnostics: vec![],
  };

  let html = render_document_html(&renderer(), &ir, &options).expect("render").html;

  assert!(html.contains("data-pagefind-search"));
  assert!(html.contains("data-pagefind-results"));
  assert!(html.contains("type=\"module\""));
  assert!(html.contains("import * as pagefind from \"/public-search/pagefind/pagefind.js\""));
  assert!(!html.contains("defer src=\"/public-search/pagefind/pagefind.js\""));
}

#[test]
fn public_social_card_renders_png_without_browser_runtime() {
  let mut fonts = myoxus_public_render::SocialCardFonts::new();
  fonts.load_font_data(
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../static/fonts/inter-vf.ttf")).unwrap(),
  );
  let png = render_social_card_png(
    &renderer(),
    &SocialCardInput {
      title: "A long but stable public document title",
      subtitle: "Workspace documentation",
      brand: "Myoxus",
      theme: Default::default(),
    },
    std::sync::Arc::new(fonts),
  )
  .expect("social card png");

  assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
  assert!(png.len() > 1024, "social card should not be an empty placeholder");
}

fn renderer() -> &'static myoxus_public_render::HtmlRenderer {
  static CAPTURED: std::sync::OnceLock<myoxus_public_render::HtmlRenderer> = std::sync::OnceLock::new();
  CAPTURED.get_or_init(|| {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
    let files = myoxus_public_render::HTML_CATALOG_FILES
      .iter()
      .map(|name| (name.to_string(), std::fs::read(root.join(name)).unwrap()))
      .collect();
    myoxus_public_render::HtmlRenderer::from_files(files).unwrap()
  })
}
