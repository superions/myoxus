use std::io::Cursor;

use crate::{
  Block, PreviewAsset, PreviewAssetKind, PreviewFont, PreviewOutputFormat, PreviewPolicy, PreviewProjectionLimits,
  PreviewRenderError, PreviewTheme, document_excerpt_from_yjs, render_page_preview,
};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use uuid::Uuid;
use yjs::{YjsDocumentBuilder, YjsTextSegment};
use yrs::{Array, Map, Text, Transact};

const INTER: &[u8] = include_bytes!("../../../static/fonts/inter-vf.ttf");

fn projection_limits() -> PreviewProjectionLimits {
  PreviewProjectionLimits {
    max_input_bytes: 1_000_000,
    max_source_blocks: 100,
    max_projected_blocks: 30,
    max_text_chars: 4_000,
    max_depth: 16,
    max_table_rows: 4,
    max_table_columns: 4,
    max_visuals: 1,
  }
}

#[test]
fn bpmn_public_and_bounded_preview_render_a_title_without_source_or_svg() {
  let blocks = vec![
    ("page", "myoxus:page", serde_json::json!({}), vec!["note"]),
    ("note", "myoxus:note", serde_json::json!({}), vec!["bpmn"]),
    (
      "bpmn",
      "myoxus:bpmn",
      serde_json::json!({
        "title":"Approve <script>alert(1)</script>",
        "sourceHeads":{"head":"<definitions>private-process-source</definitions>"},
        "preview":"<svg onload='private-preview-code()'/>"
      }),
      vec![],
    ),
  ]
  .into_iter()
  .map(|(id, flavour, props, children)| yjs::PortableSnapshotBlock {
    id: id.into(),
    flavour: flavour.into(),
    version: None,
    props: props.as_object().unwrap().clone(),
    children: children.into_iter().map(str::to_string).collect(),
  })
  .collect::<Vec<_>>();
  let update = yjs::snapshot_blocks_to_yjs(&blocks).unwrap();
  let options = crate::HtmlRenderOptions {
    canonical_url: "https://example.test/public/ws/doc".into(),
    theme_css_url: "/api/branding/theme.css".into(),
    favicon_url: "/favicon.ico".into(),
    noindex: false,
    locale: "en".into(),
    snapshot_relative_links: false,
    site_shell: Default::default(),
  };
  let full = crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Document", "page", &update).unwrap();
  assert!(full.mutation_partial);
  let preview = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Document",
    "page",
    &update,
    &projection_limits(),
  )
  .unwrap();
  for ir in [full, preview] {
    assert!(!ir.diagnostics.is_empty());
    let html = crate::render_document_html(&crate::catalog::test_renderer(), &ir, &options)
      .unwrap()
      .html;
    assert!(html.contains(&format!(
      "BPMN: {}",
      v_htmlescape::escape("Approve <script>alert(1)</script>")
    )));
    for hidden in [
      "private-process-source",
      "private-preview-code",
      "<script>alert(1)",
      "<svg onload",
    ] {
      assert!(!html.contains(hidden));
    }
    assert!(ir.document.assets.is_empty());
  }
  let mut limits = projection_limits();
  limits.max_text_chars = 10;
  let bounded = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Document", "page", &update, &limits).unwrap();
  assert!(
    matches!(&bounded.document.blocks[0], Block::Paragraph { text, .. } if text.iter().map(|t| t.text.chars().count()).sum::<usize>() <= 10)
  );
}

#[test]
fn database_references_static_public_and_preview_do_not_disclose_payload_or_descendants() {
  let private_workspace = Uuid::new_v4();
  let private_database = Uuid::new_v4();
  let private_row = Uuid::new_v4();
  for reference in [
    serde_json::json!({"serverRowId":private_row}),
    serde_json::json!({"serverReferencePresentation":"compact"}),
    serde_json::json!({"templateReference":{"key":"context.container","kind":"database","optional":true}}),
    serde_json::json!({"templateReference":{}}),
    serde_json::json!({"serverRowId":{}}),
    serde_json::json!({"serverReferencePresentation":{}}),
  ] {
    let mut private_props = serde_json::json!({"serverWorkspaceId":private_workspace,"serverDatabaseId":private_database,"title":"Private Task title","text":"Private Task body","cells":{"secret":"Private cell"}});
    private_props
      .as_object_mut()
      .unwrap()
      .extend(reference.as_object().unwrap().clone());
    let blocks = vec![
      ("page", "myoxus:page", serde_json::json!({}), vec!["note"]),
      ("note", "myoxus:note", serde_json::json!({}), vec!["task"]),
      ("task", "myoxus:database", private_props, vec!["secret"]),
      (
        "secret",
        "myoxus:paragraph",
        serde_json::json!({"text":"Private descendant"}),
        vec![],
      ),
    ]
    .into_iter()
    .map(|(id, flavour, props, children)| yjs::PortableSnapshotBlock {
      id: id.into(),
      flavour: flavour.into(),
      version: None,
      props: props.as_object().unwrap().clone(),
      children: children.into_iter().map(str::to_string).collect(),
    })
    .collect::<Vec<_>>();
    let update = yjs::snapshot_blocks_to_yjs(&blocks).unwrap();
    let workspace = Uuid::new_v4();
    let doc = Uuid::new_v4();
    let full = crate::document_from_yjs(workspace, doc, "Document", "page", &update).unwrap();
    let limits = projection_limits();
    let preview = crate::document_excerpt_from_yjs(workspace, doc, "Document", "page", &update, &limits).unwrap();
    let rootless_update = yjs::snapshot_blocks_to_yjs(&blocks[1..]).unwrap();
    let rootless = crate::document_from_yjs(workspace, doc, "Document", "page", &rootless_update).unwrap();
    assert!(
      crate::document_excerpt_from_yjs(workspace, doc, "Document", "page", &rootless_update, &limits).is_err(),
      "preview requires a Page root"
    );
    let options = crate::HtmlRenderOptions {
      canonical_url: "https://example.test/public/ws/doc".into(),
      theme_css_url: "/api/branding/theme.css".into(),
      favicon_url: "/favicon.ico".into(),
      noindex: false,
      locale: "en".into(),
      snapshot_relative_links: false,
      site_shell: Default::default(),
    };
    for ir in [full, preview, rootless] {
      let html = crate::render_document_html(&crate::catalog::test_renderer(), &ir, &options)
        .unwrap()
        .html;
      assert!(html.contains("Target unavailable"));
      for target in [private_workspace, private_database, private_row] {
        assert!(!html.contains(&target.to_string()), "private target identity");
      }
      for secret in [
        "Private Task title",
        "Private Task body",
        "Private cell",
        "Private descendant",
      ] {
        assert!(!html.contains(secret), "{secret}");
      }
    }
  }
}

#[test]
fn native_note_title_and_body_survive_public_and_preview_projection() {
  let payload =
    yjs::markdown_to_yjs("Notes", "> [!note] Current & approval\n> Visible body\n").expect("native Markdown import");
  let public =
    crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Notes", "Page", &payload).expect("public projection");
  let preview = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Notes",
    "Page",
    &payload,
    &projection_limits(),
  )
  .expect("preview projection");
  for ir in [&public, &preview] {
    let Block::Callout { title, text, .. } = &ir.document.blocks[0] else {
      panic!("native callout");
    };
    assert_eq!(title.as_deref(), Some("Current & approval"));
    assert_eq!(
      text.iter().map(|span| span.text.as_str()).collect::<String>(),
      "Visible body"
    );
  }
  let options = crate::HtmlRenderOptions {
    canonical_url: "https://example.test/public/notes".into(),
    theme_css_url: "/api/branding/theme.css".into(),
    favicon_url: "/favicon.ico".into(),
    noindex: false,
    locale: "de-DE".into(),
    snapshot_relative_links: false,
    site_shell: Default::default(),
  };
  let html = crate::render_document_html(&crate::catalog::test_renderer(), &public, &options)
    .expect("HTML projection")
    .html;
  assert!(html.contains("Current &amp; approval"));
  assert!(html.contains("Visible body"));
  let default = yjs::markdown_to_yjs("Notes", "> [!note]\n> Body\n").expect("default title import");
  let default =
    crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Notes", "Page", &default).expect("default projection");
  let html = crate::render_document_html(&crate::catalog::test_renderer(), &default, &options)
    .expect("localized HTML projection")
    .html;
  assert!(html.contains("Hinweis"));
  let mut limits = projection_limits();
  // The document's five-character title shares the total excerpt budget.
  limits.max_text_chars = 12;
  let bounded = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Notes", "Page", &payload, &limits)
    .expect("bounded note projection");
  let Block::Callout { title, text, .. } = &bounded.document.blocks[0] else {
    panic!("bounded note");
  };
  assert_eq!(bounded.document.title, "Notes");
  assert_eq!(title.as_deref(), Some("Current"));
  assert!(text.is_empty(), "the title consumes the same budget as the body");
  assert!(
    bounded
      .diagnostics
      .iter()
      .any(|finding| finding.code == "preview_excerpt_truncated")
  );
}

#[test]
fn folded_typed_callouts_expose_complete_reading_content_and_bounded_kind_labels() {
  let payload = yjs::markdown_to_yjs(
    "Notes",
    "> [!Research_Review]-\n> Visible body\n>\n> > [!TIP]- Recovery\n> > Rollback instructions\n",
  )
  .unwrap();
  let public = crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Notes", "Page", &payload).unwrap();
  let preview = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Notes",
    "Page",
    &payload,
    &projection_limits(),
  )
  .unwrap();
  for ir in [&public, &preview] {
    let Block::Callout {
      title, text, children, ..
    } = &ir.document.blocks[0]
    else {
      panic!("typed callout")
    };
    assert_eq!(title.as_deref(), Some("Research_Review"));
    assert_eq!(
      text.iter().map(|span| span.text.as_str()).collect::<String>(),
      "Visible body"
    );
    let Block::Callout { title, text, .. } = &children[0] else {
      panic!("nested folded content remains visible")
    };
    assert_eq!(title.as_deref(), Some("Recovery"));
    assert_eq!(
      text.iter().map(|span| span.text.as_str()).collect::<String>(),
      "Rollback instructions"
    );
  }
  let mut limits = projection_limits();
  limits.max_text_chars = 12;
  let bounded = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Notes", "Page", &payload, &limits).unwrap();
  let Block::Callout { title, text, .. } = &bounded.document.blocks[0] else {
    panic!("bounded callout")
  };
  assert_eq!(title.as_deref(), Some("Researc"));
  assert!(text.is_empty());
  assert!(
    bounded
      .diagnostics
      .iter()
      .any(|finding| finding.code == "preview_excerpt_truncated")
  );
}

#[test]
fn annotations_are_hidden_in_public_and_preview_without_mutating_source() {
  let doc = yrs::Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
  page.insert(&mut txn, "sys:flavour", "myoxus:page");
  let children = page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  for (id, flavour, body) in [
    ("before", "myoxus:paragraph", "Visible before"),
    ("annotation", "myoxus:annotation", "Private **annotation**\nSecond line"),
    ("after", "myoxus:paragraph", "Visible after"),
  ] {
    let block = blocks.insert(&mut txn, id, yrs::MapPrelim::default());
    block.insert(&mut txn, "sys:flavour", flavour);
    block.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    let text = block.insert(&mut txn, "prop:text", yrs::TextPrelim::new(body));
    if id == "before" {
      let identity = yrs::Any::Map(std::sync::Arc::new(
        [("id".into(), yrs::Any::String("a".into()))].into(),
      ));
      text.insert_with_attributes(
        &mut txn,
        7,
        "Hidden inline\n",
        [("annotation".into(), identity.clone())].into(),
      );
      text.insert_with_attributes(
        &mut txn,
        21,
        "second delta",
        [("annotation".into(), identity), ("bold".into(), yrs::Any::Bool(true))].into(),
      );
    }
    children.push_back(&mut txn, id);
  }
  let payload = txn.encode_update_v1();
  drop(txn);
  let public =
    crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Title", "Page", &payload).expect("public projection");
  let mut limits = projection_limits();
  limits.max_projected_blocks = 2;
  let preview = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Title", "Page", &payload, &limits)
    .expect("preview projection");
  for ir in [&public, &preview] {
    assert_eq!(ir.document.blocks.len(), 2);
    assert_eq!(ir.document.blocks[0].block_id(), "before");
    assert_eq!(ir.document.blocks[1].block_id(), "after");
    assert!(
      ir.diagnostics.is_empty(),
      "hidden content is not an unsupported placeholder"
    );
    assert!(!format!("{ir:?}").contains("Private **annotation**"));
    assert!(!format!("{ir:?}").contains("Hidden inline"));
    assert!(!format!("{ir:?}").contains("second delta"));
    let Block::Paragraph { text, .. } = &ir.document.blocks[0] else {
      panic!("visible paragraph")
    };
    assert_eq!(
      text.iter().map(|span| span.text.as_str()).collect::<String>(),
      "Visible before"
    );
  }
}

fn render_policy() -> PreviewPolicy {
  PreviewPolicy {
    projection: projection_limits(),
    max_font_bytes: INTER.len() + 1,
    max_media_bytes: 500_000,
    max_decoded_image_pixels: 1_000_000,
    max_svg_input_bytes: 500_000,
    max_mermaid_source_bytes: 20_000,
    max_mermaid_elements: 100,
    max_outlined_paths: 20_000,
    max_output_svg_bytes: 2_000_000,
    max_png_pixels: 640 * 400,
  }
}

fn context() -> crate::PreparedPreviewContext {
  crate::PreparedPreviewContext::prepare(
    "theme-font-r1",
    theme(),
    vec![PreviewFont { bytes: INTER.to_vec() }],
    &render_policy(),
  )
  .expect("prepare explicit preview font")
}

fn theme() -> PreviewTheme {
  PreviewTheme {
    background: "#ffffff".to_string(),
    surface: "#f3f4f6".to_string(),
    text: "#202124".to_string(),
    muted: "#5f6368".to_string(),
    border: "#d5d7da".to_string(),
    accent: "#7d2841".to_string(),
    body_font_family: "Inter".to_string(),
    heading_font_family: "Inter".to_string(),
    mono_font_family: "Inter".to_string(),
  }
}

fn raster_fixture() -> Vec<u8> {
  let mut image = RgbaImage::new(48, 32);
  for (x, y, pixel) in image.enumerate_pixels_mut() {
    *pixel = if (x + y) % 2 == 0 {
      Rgba([125, 40, 65, 255])
    } else {
      Rgba([31, 58, 82, 255])
    };
  }
  let mut bytes = Cursor::new(Vec::new());
  DynamicImage::ImageRgba8(image)
    .write_to(&mut bytes, ImageFormat::Png)
    .expect("encode raster fixture");
  bytes.into_inner()
}

#[test]
fn svg_preview_blocks_local_files_and_preserves_embedded_images() {
  use base64::Engine as _;
  let directory = tempfile::Builder::new().prefix("svg-preview-").tempdir_in(".").unwrap();
  let path = directory.path().join("private.png");
  let png = raster_fixture();
  std::fs::write(&path, &png).unwrap();
  let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
  let mut builder = YjsDocumentBuilder::new("Safe SVG");
  builder.push_image("svg-fixture", "SVG fixture");
  let ir = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Safe SVG",
    "Page",
    &builder.encode(),
    &projection_limits(),
  )
  .unwrap();
  let context = context();
  let render = |href: &str, format| {
    let asset = PreviewAsset {
      source: "svg-fixture".into(), revision: "fixture-r1".into(), kind: PreviewAssetKind::Svg,
      bytes: format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><image href="{href}" width="48" height="32"/></svg>"#).into_bytes(),
    };
    render_page_preview(&ir, &[asset], &context, &render_policy(), format).unwrap()
  };
  for href in [path.canonicalize().unwrap(), path] {
    let control = format!(
      r#"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><image href="{}" width="48" height="32"/></svg>"#,
      href.display()
    );
    assert!(
      usvg::Tree::from_data(control.as_bytes(), &usvg::Options::default())
        .unwrap()
        .to_string(&usvg::WriteOptions::default())
        .contains(&encoded),
      "fixture must exercise a readable local image"
    );
    let output = render(href.to_str().unwrap(), PreviewOutputFormat::Svg);
    let svg = std::str::from_utf8(&output.bytes).unwrap();
    assert!(
      !svg.contains("<image"),
      "local files must not enter the rendered preview"
    );
    assert!(!svg.contains(&encoded));
  }
  let href = format!("data:image/png;base64,{encoded}");
  let output = render(&href, PreviewOutputFormat::Svg);
  assert!(std::str::from_utf8(&output.bytes).unwrap().contains(&encoded));
  let output = render(&href, PreviewOutputFormat::Png);
  let raster = image::load_from_memory(&output.bytes).unwrap().to_rgba8();
  for color in [[125, 40, 65, 255], [31, 58, 82, 255]] {
    assert!(
      raster.pixels().any(|pixel| pixel.0 == color),
      "embedded fixture colors must reach the final raster"
    );
  }
}

fn rasterized_content_bounds(svg: &[u8], scale: f32) -> ((u32, u32, u32, u32), Vec<u8>) {
  let tree = usvg::Tree::from_data(svg, &usvg::Options::default()).expect("parse outlined preview SVG");
  let width = (640.0 * scale) as u32;
  let height = (400.0 * scale) as u32;
  let mut pixmap = tiny_skia::Pixmap::new(width, height).expect("allocate scaled preview");
  resvg::render(
    &tree,
    tiny_skia::Transform::from_scale(scale, scale),
    &mut pixmap.as_mut(),
  );
  let mut min_x = width;
  let mut min_y = height;
  let mut max_x = 0;
  let mut max_y = 0;
  for y in 0..height {
    for x in 0..width {
      let index = ((y * width + x) * 4) as usize;
      let pixel = &pixmap.data()[index..index + 4];
      if pixel != [255, 255, 255, 255] {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
      }
    }
  }
  assert!(
    min_x <= max_x && min_y <= max_y,
    "scaled SVG must contain visible content"
  );
  let png = pixmap.encode_png().expect("encode scaled preview evidence");
  ((min_x, min_y, max_x, max_y), png)
}

#[test]
fn page_excerpt_renders_semantic_svg_and_png_from_the_same_bounded_source() {
  let mut builder = YjsDocumentBuilder::new("Quarterly delivery");
  builder.push_heading(2, &[YjsTextSegment::plain("Outcomes")]);
  builder.push_paragraph(&[YjsTextSegment::plain(
    "A structured paragraph that wraps using metrics from the supplied server font.",
  )]);
  builder.push_quote(&[YjsTextSegment::plain("A quoted constraint")]);
  builder.push_list_item(&[YjsTextSegment::plain("Shipped")], false, 0, Some(true));
  builder.push_code("rust", "fn bounded() -> bool { true }");
  builder.push_table(&[
    vec![
      vec![YjsTextSegment::plain("Owner")],
      vec![YjsTextSegment::plain("State")],
    ],
    vec![
      vec![YjsTextSegment::plain("Preview")],
      vec![YjsTextSegment::plain("Ready")],
    ],
  ]);
  builder.push_image("asset-a", "Checkerboard");
  let payload = builder.encode();
  let original = payload.clone();
  let ir = document_excerpt_from_yjs(
    Uuid::new_v4(),
    Uuid::new_v4(),
    "Fallback",
    "Page",
    &payload,
    &projection_limits(),
  )
  .expect("bounded Page projection");
  assert_eq!(payload, original, "preview projection must not mutate input bytes");

  let asset = PreviewAsset {
    source: "asset-a".to_string(),
    revision: "asset-r1".to_string(),
    kind: PreviewAssetKind::Raster,
    bytes: raster_fixture(),
  };
  let context = context();
  let svg = render_page_preview(
    &ir,
    std::slice::from_ref(&asset),
    &context,
    &render_policy(),
    PreviewOutputFormat::Svg,
  )
  .expect("render SVG");
  let svg_text = std::str::from_utf8(&svg.bytes).expect("UTF-8 SVG");
  assert_eq!(svg.mime_type, "image/svg+xml");
  assert!(svg_text.contains("viewBox=\"0 0 640 400\""));
  assert!((1..=400).contains(&svg.content_height));
  assert!(!svg.partial && !svg.truncated);
  assert!(
    svg_text.contains("<path"),
    "font outlines and semantic geometry must survive"
  );
  assert!(!svg_text.contains("<text"), "all preview text must be outlined");
  assert!(!svg_text.contains("Quarterly delivery"));
  assert!(
    svg_text.contains("data:image/png"),
    "the resolved source image must be embedded"
  );
  assert!(
    svg.diagnostics.is_empty(),
    "all supported source blocks should render cleanly"
  );
  let (full_bounds, full_png) = rasterized_content_bounds(&svg.bytes, 1.0);
  let (half_bounds, half_png) = rasterized_content_bounds(&svg.bytes, 0.5);
  assert!(
    full_bounds.2 < 640 && full_bounds.3 < 400,
    "content must remain inside the protected viewport"
  );
  assert!(
    half_bounds.2 < 320 && half_bounds.3 < 200,
    "scaled content must remain inside the viewport"
  );
  assert!((half_bounds.2 as i64 * 2 - full_bounds.2 as i64).abs() <= 3);
  assert!((half_bounds.3 as i64 * 2 - full_bounds.3 as i64).abs() <= 3);
  if let Some(directory) = std::env::var_os("MYOXUS_PREVIEW_EVIDENCE_DIR") {
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).expect("create explicit preview evidence directory");
    std::fs::write(directory.join("page-preview.svg"), &svg.bytes).expect("write SVG evidence");
    std::fs::write(directory.join("page-preview-640.png"), full_png).expect("write full-scale PNG evidence");
    std::fs::write(directory.join("page-preview-320.png"), half_png).expect("write half-scale PNG evidence");
  }

  let png = render_page_preview(&ir, &[asset], &context, &render_policy(), PreviewOutputFormat::Png)
    .expect("render PNG derivative");
  let decoded = image::load_from_memory(&png.bytes).expect("decode generated PNG");
  assert_eq!((decoded.width(), decoded.height()), (640, 400));
  assert_eq!(png.content_height, svg.content_height);
  assert_eq!((png.partial, png.truncated), (svg.partial, svg.truncated));
  assert!(decoded.to_rgba8().pixels().any(|pixel| pixel.0 != [255, 255, 255, 255]));
}

#[test]
fn inline_marks_remain_local_and_long_tokens_wrap_without_losing_the_suffix() {
  let render = |mark: Option<&str>| {
    let mut styled = YjsTextSegment::plain("evidence");
    match mark {
      Some("bold") => styled.bold = true,
      Some("italic") => styled.italic = true,
      Some("strike") => styled.strike = true,
      Some("code") => styled.code = true,
      Some("link") => styled.link = Some("https://example.test".into()),
      _ => {}
    }
    let mut builder = YjsDocumentBuilder::new("Marks");
    builder.push_paragraph(&[
      YjsTextSegment::plain("plain "),
      styled,
      YjsTextSegment::plain(" context"),
    ]);
    let ir = document_excerpt_from_yjs(
      Uuid::nil(),
      Uuid::nil(),
      "Marks",
      "Page",
      &builder.encode(),
      &projection_limits(),
    )
    .unwrap();
    let output = render_page_preview(&ir, &[], &context(), &render_policy(), PreviewOutputFormat::Png).unwrap();
    assert!(!output.partial && !output.truncated);
    image::load_from_memory(&output.bytes).unwrap().to_rgba8()
  };
  let plain = render(None);
  for mark in ["bold", "italic", "strike", "code", "link"] {
    let marked = render(Some(mark));
    let pixels = |image: &RgbaImage, left: u32, right: u32| {
      (0..image.height())
        .flat_map(move |y| (left..right).map(move |x| image.get_pixel(x, y).0))
        .collect::<Vec<_>>()
    };
    assert_eq!(
      pixels(&plain, 20, 45),
      pixels(&marked, 20, 45),
      "{mark} must not affect the plain prefix"
    );
    assert!(
      pixels(&plain, 55, 200) != pixels(&marked, 55, 200),
      "{mark} must affect its own run"
    );
  }

  let mut builder = YjsDocumentBuilder::new("Wrap");
  let mut marked = YjsTextSegment::plain("x".repeat(300));
  marked.bold = true;
  builder.push_paragraph(&[marked, YjsTextSegment::plain(" suffix")]);
  let ir = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Wrap",
    "Page",
    &builder.encode(),
    &projection_limits(),
  )
  .unwrap();
  let output = render_page_preview(&ir, &[], &context(), &render_policy(), PreviewOutputFormat::Svg).unwrap();
  assert!(
    !output.truncated,
    "the suffix fits after wrapping the long marked token"
  );
  assert!(
    output.content_height > 100,
    "the token occupies multiple lines rather than being clipped: height {}",
    output.content_height
  );
}

#[test]
fn projection_stops_before_unadmitted_block_text_and_reports_the_limit() {
  let mut builder = YjsDocumentBuilder::new("Bounded");
  for index in 0..12 {
    builder.push_paragraph(&[YjsTextSegment::plain(format!("paragraph-{index}"))]);
  }
  let payload = builder.encode();
  let mut limits = projection_limits();
  limits.max_projected_blocks = 3;
  let ir = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Fallback", "Page", &payload, &limits)
    .expect("bounded projection remains useful");
  assert_eq!(ir.document.blocks.len(), 3);
  assert!(
    ir.diagnostics
      .iter()
      .any(|item| item.code == "preview_excerpt_truncated")
  );

  let error = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Fallback", "Edgeless", &[], &limits)
    .expect_err("Edgeless must be an honest unsupported state");
  assert_eq!(error.code, "preview_unsupported_mode");

  limits.max_input_bytes = payload.len() - 1;
  let error = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Fallback", "Page", &payload, &limits)
    .expect_err("input bytes must be rejected before projection");
  assert_eq!(error.code, "preview_input_limit");

  let mut policy = render_policy();
  policy.max_png_pixels = 640 * 400 - 1;
  let error = render_page_preview(&ir, &[], &context(), &policy, PreviewOutputFormat::Png)
    .expect_err("PNG allocation must obey the resolved pixel budget");
  assert!(matches!(error, PreviewRenderError::PngPixelLimit));

  let mut short_builder = YjsDocumentBuilder::new("Short");
  short_builder.push_paragraph(&[YjsTextSegment::plain("One line")]);
  let short_ir = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Fallback",
    "Page",
    &short_builder.encode(),
    &projection_limits(),
  )
  .expect("short fixture projection");
  let short = render_page_preview(&short_ir, &[], &context(), &render_policy(), PreviewOutputFormat::Svg)
    .expect("short viewport render");
  assert!(
    (20..400).contains(&short.content_height),
    "short excerpt uses its painted bounds"
  );
  assert!(!short.partial && !short.truncated);

  let mut viewport_builder = YjsDocumentBuilder::new("Viewport");
  for index in 0..20 {
    viewport_builder.push_paragraph(&[YjsTextSegment::plain(format!(
      "Visible line {index} fills the fixed preview viewport predictably."
    ))]);
  }
  let viewport_ir = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Fallback",
    "Page",
    &viewport_builder.encode(),
    &projection_limits(),
  )
  .expect("viewport fixture projection");
  let output = render_page_preview(
    &viewport_ir,
    &[],
    &context(),
    &render_policy(),
    PreviewOutputFormat::Svg,
  )
  .expect("bounded viewport render");
  assert!(
    output
      .diagnostics
      .iter()
      .any(|item| item.code == "preview_viewport_truncated")
  );
  assert!(output.truncated && output.partial);
  assert!(output.content_height > short.content_height);
}

#[test]
fn missing_media_is_partial_and_active_svg_content_never_reaches_output() {
  let mut builder = YjsDocumentBuilder::new("Safe media");
  builder.push_paragraph(&[YjsTextSegment::plain("Useful text remains visible")]);
  builder.push_image("missing", "Missing image");
  let ir = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Fallback",
    "Page",
    &builder.encode(),
    &projection_limits(),
  )
  .expect("Page projection");
  let output =
    render_page_preview(&ir, &[], &context(), &render_policy(), PreviewOutputFormat::Svg).expect("partial output");
  assert!(
    output
      .diagnostics
      .iter()
      .any(|item| item.code == "preview_media_missing")
  );
  assert!(output.bytes.len() > 1_000, "useful outlined text must remain visible");
  assert!(output.partial && !output.truncated);
  let mut without_image = ir.clone();
  without_image.document.blocks.pop();
  let without_image = render_page_preview(
    &without_image,
    &[],
    &context(),
    &render_policy(),
    PreviewOutputFormat::Svg,
  )
  .expect("text-only comparison");
  assert!(
    output.content_height > without_image.content_height + 20,
    "missing media retains a visible slot"
  );

  let hostile = PreviewAsset {
    source: "missing".to_string(),
    revision: "hostile-r1".to_string(),
    kind: PreviewAssetKind::Svg,
    bytes: br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><script>alert(1)</script><foreignObject/><a href="https://example.test"><rect width="20" height="20"/></a></svg>"#.to_vec(),
  };
  let output = render_page_preview(&ir, &[hostile], &context(), &render_policy(), PreviewOutputFormat::Svg)
    .expect("restricted SVG round-trip");
  let svg = std::str::from_utf8(&output.bytes).unwrap().to_ascii_lowercase();
  assert!(!svg.contains("script"));
  assert!(!svg.contains("foreignobject"));
  assert!(!svg.contains("example.test"));
  assert!(!svg.contains("<a"));

  let oversized = PreviewAsset {
    source: "missing".to_string(),
    revision: "large-r1".to_string(),
    kind: PreviewAssetKind::Raster,
    bytes: raster_fixture(),
  };
  let mut policy = render_policy();
  policy.max_media_bytes = 1;
  let output = render_page_preview(&ir, &[oversized], &context(), &policy, PreviewOutputFormat::Svg)
    .expect("media failure must keep a useful partial preview");
  assert!(output.diagnostics.iter().any(|item| item.code == "preview_media_limit"));
  assert!(output.bytes.len() > 1_000);

  let mut policy = render_policy();
  policy.max_outlined_paths = 1;
  let error = render_page_preview(&ir, &[], &context(), &policy, PreviewOutputFormat::Svg)
    .expect_err("text outlining must obey the path budget before final serialization");
  assert!(matches!(error, PreviewRenderError::OutputLimit));
}

#[test]
fn prepared_context_fails_closed_without_the_resolved_font_family() {
  let mut missing = theme();
  missing.body_font_family = "Missing Family".to_string();
  let error = crate::PreparedPreviewContext::prepare(
    "missing-font-r1",
    missing,
    vec![PreviewFont { bytes: INTER.to_vec() }],
    &render_policy(),
  )
  .expect_err("host font discovery must never hide a missing resolved font");
  assert!(matches!(error, PreviewRenderError::MissingFontFamily(family) if family == "Missing Family"));

  let error = crate::PreparedPreviewContext::prepare("empty-font-r1", theme(), Vec::new(), &render_policy())
    .expect_err("an empty resolved font set is not a valid rendering context");
  assert!(matches!(error, PreviewRenderError::FontLimit));
}

#[test]
fn long_paragraph_keeps_its_unicode_prefix_and_rich_text_at_the_budget() {
  let mut builder = YjsDocumentBuilder::new("Prefix");
  let first = "é🙂漢字";
  let mut marked = YjsTextSegment::plain(first);
  marked.bold = true;
  builder.push_paragraph(&[marked, YjsTextSegment::plain("x".repeat(10_000))]);
  builder.push_paragraph(&[YjsTextSegment::plain("This later block must not enter the excerpt")]);
  let payload = builder.encode();
  let source = format!("{first}{}", "x".repeat(10_000));
  for budget in [7, 64, 4_000] {
    let mut limits = projection_limits();
    limits.max_text_chars = budget;
    let ir = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "", "Page", &payload, &limits)
      .expect("a long first paragraph still has a useful bounded prefix");
    assert_eq!(ir.document.blocks.len(), 1);
    let Block::Paragraph { text, .. } = &ir.document.blocks[0] else {
      panic!("the admitted paragraph must not disappear");
    };
    let actual = text.iter().map(|span| span.text.as_str()).collect::<String>();
    assert_eq!(actual, source.chars().take(budget - "Prefix".len()).collect::<String>());
    assert!(text[0].bold, "the prefix must retain source marks");
    if text.len() > 1 {
      assert!(!text[1].bold);
    }
    assert!(
      ir.diagnostics
        .iter()
        .any(|item| item.code == "preview_excerpt_truncated")
    );
  }
}

#[test]
fn table_projection_reports_dimension_truncation_without_losing_the_excerpt() {
  let mut builder = YjsDocumentBuilder::new("Bounded table");
  builder.push_table(&[
    vec![vec![YjsTextSegment::plain("A1")], vec![YjsTextSegment::plain("B1")]],
    vec![vec![YjsTextSegment::plain("A2")], vec![YjsTextSegment::plain("B2")]],
  ]);
  let mut limits = projection_limits();
  limits.max_table_rows = 1;
  limits.max_table_columns = 1;
  let ir = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Fallback", "Page", &builder.encode(), &limits)
    .expect("bounded table projection");
  let Block::Table { rows, .. } = &ir.document.blocks[0] else {
    panic!("the admitted table must remain a semantic table");
  };
  assert_eq!((rows.len(), rows[0].len()), (1, 1));
  assert_eq!(rows[0][0][0].text, "A1");
  assert!(ir.diagnostics.iter().any(|item| item.code == "preview_table_truncated"));

  let mut builder = YjsDocumentBuilder::new("Cell");
  builder.push_table(&[vec![
    vec![YjsTextSegment::plain(format!("é🙂漢字{}", "x".repeat(1_000)))],
    vec![YjsTextSegment::plain("Later cells must not displace the first cell")],
  ]]);
  limits.max_table_columns = 2;
  limits.max_text_chars = "Cell".len() + 3;
  let ir = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "", "Page", &builder.encode(), &limits)
    .expect("the first table cell retains the admitted Unicode prefix");
  let Block::Table { rows, .. } = &ir.document.blocks[0] else {
    panic!("the bounded cell must remain in the table");
  };
  assert_eq!(rows[0][0][0].text, "é🙂漢");
  assert!(rows[0][1].is_empty());
  assert!(ir.diagnostics.iter().any(|item| item.code == "preview_table_truncated"));
}

#[test]
fn preview_table_wraps_cells_in_place_and_only_admits_complete_rows() {
  let table = |long: bool| {
    let mut builder = YjsDocumentBuilder::new("Table");
    builder.push_table(&[
      vec![
        vec![YjsTextSegment::plain("Severity")],
        vec![YjsTextSegment::plain("Evidence")],
      ],
      vec![
        vec![YjsTextSegment::plain("High")],
        vec![YjsTextSegment::plain(if long {
          "uninterrupted_token_with_no_spaces_".repeat(4)
        } else {
          "Brief".to_string()
        })],
      ],
    ]);
    let mut ir = document_excerpt_from_yjs(
      Uuid::nil(),
      Uuid::nil(),
      "Table",
      "Page",
      &builder.encode(),
      &projection_limits(),
    )
    .unwrap();
    let Block::Table { header_rows, .. } = &mut ir.document.blocks[0] else {
      panic!("table")
    };
    *header_rows = Some(1);
    ir
  };
  let short = render_page_preview(
    &table(false),
    &[],
    &context(),
    &render_policy(),
    PreviewOutputFormat::Png,
  )
  .unwrap();
  let long = render_page_preview(
    &table(true),
    &[],
    &context(),
    &render_policy(),
    PreviewOutputFormat::Png,
  )
  .unwrap();
  assert!(!short.truncated && !long.truncated);
  assert!(
    long.content_height > short.content_height + 50,
    "long tokens wrap within their own cell"
  );
  let short_image = image::load_from_memory(&short.bytes).unwrap().to_rgba8();
  let long_image = image::load_from_memory(&long.bytes).unwrap().to_rgba8();
  assert!(
    (320..610).any(|x| (110..long.content_height).any(|y| short_image.get_pixel(x, y) != long_image.get_pixel(x, y))),
    "the second column must contain the long cell instead of dropping its suffix"
  );

  let mut blocked = table(true);
  for index in 0..9 {
    blocked.document.blocks.insert(
      0,
      Block::Paragraph {
        block_id: format!("intro-{index}"),
        text: vec![crate::InlineText::plain("Context before the table")],
      },
    );
  }
  let output = render_page_preview(&blocked, &[], &context(), &render_policy(), PreviewOutputFormat::Svg).unwrap();
  assert!(output.truncated && output.partial);
  assert!(
    output
      .diagnostics
      .iter()
      .any(|item| item.code == "preview_table_truncated")
  );
  assert!(
    output.content_height <= 400,
    "no half-painted cell may overrun the viewport"
  );
  blocked.document.blocks.push(Block::Paragraph {
    block_id: "after-table".into(),
    text: vec![crate::InlineText::plain("Must not replace omitted table content")],
  });
  let with_following =
    render_page_preview(&blocked, &[], &context(), &render_policy(), PreviewOutputFormat::Svg).unwrap();
  assert_eq!(
    output.bytes, with_following.bytes,
    "following blocks cannot stand in for a missing table row"
  );
}

#[test]
fn mermaid_uses_the_real_renderer_and_exhausted_visual_budget_is_explicit() {
  let doc = yrs::Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  let make = |txn: &mut yrs::TransactionMut<'_>, id: &str, flavour: &str| {
    let block = blocks.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:children", yrs::ArrayPrelim::default())
  };
  let page_children = make(&mut txn, "page", "myoxus:page");
  let note_children = make(&mut txn, "note", "myoxus:note");
  let callout_children = make(&mut txn, "callout", "myoxus:callout");
  let _detail_children = make(&mut txn, "detail", "myoxus:paragraph");
  let _diagram_children = make(&mut txn, "diagram", "myoxus:mermaid");
  page_children.push_back(&mut txn, "note");
  note_children.push_back(&mut txn, "callout");
  note_children.push_back(&mut txn, "diagram");
  callout_children.push_back(&mut txn, "detail");
  for (id, text) in [("callout", "Delivery constraint"), ("detail", "Nested semantic detail")] {
    let block = blocks
      .get(&txn, id)
      .and_then(|value| match value {
        yrs::Out::YMap(value) => Some(value),
        _ => None,
      })
      .unwrap();
    block.insert(&mut txn, "prop:text", yrs::TextPrelim::new(text));
  }
  let diagram = blocks
    .get(&txn, "diagram")
    .and_then(|value| match value {
      yrs::Out::YMap(value) => Some(value),
      _ => None,
    })
    .unwrap();
  diagram.insert(
    &mut txn,
    "prop:source",
    yrs::TextPrelim::new("flowchart TD\n A[Start] --> B[Done]"),
  );
  diagram.insert(&mut txn, "prop:title", "Release flow");
  let payload = txn.encode_update_v1();
  drop(txn);

  let ir = document_excerpt_from_yjs(
    Uuid::nil(),
    Uuid::nil(),
    "Mermaid",
    "Page",
    &payload,
    &projection_limits(),
  )
  .expect("Mermaid projection");
  assert!(matches!(ir.document.blocks.first(), Some(Block::Callout { children, .. }) if children.len() == 1));
  assert!(matches!(ir.document.blocks.get(1), Some(Block::Mermaid { .. })));
  let output =
    render_page_preview(&ir, &[], &context(), &render_policy(), PreviewOutputFormat::Svg).expect("real Mermaid render");
  assert!(output.bytes.len() > 1_000);
  assert!(
    !output
      .diagnostics
      .iter()
      .any(|item| item.code == "preview_mermaid_unsupported")
  );
  assert!(output.partial && !output.truncated);
  assert!(
    output
      .diagnostics
      .iter()
      .any(|item| item.code == "preview_mermaid_simplified")
  );
  let (full_bounds, full_png) = rasterized_content_bounds(&output.bytes, 1.0);
  let (half_bounds, half_png) = rasterized_content_bounds(&output.bytes, 0.5);
  assert!(full_bounds.2 < 640 && full_bounds.3 < 400);
  assert!((half_bounds.2 as i64 * 2 - full_bounds.2 as i64).abs() <= 3);
  if let Some(directory) = std::env::var_os("MYOXUS_PREVIEW_EVIDENCE_DIR") {
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).expect("create explicit preview evidence directory");
    std::fs::write(directory.join("mermaid-preview.svg"), &output.bytes).expect("write Mermaid SVG evidence");
    std::fs::write(directory.join("mermaid-preview-640.png"), full_png).expect("write full-scale Mermaid evidence");
    std::fs::write(directory.join("mermaid-preview-320.png"), half_png).expect("write half-scale Mermaid evidence");
  }

  let mut limits = projection_limits();
  limits.max_visuals = 0;
  let ir = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Mermaid", "Page", &payload, &limits)
    .expect("partial projection");
  assert!(ir.diagnostics.iter().any(|item| item.code == "preview_visual_limit"));
  assert!(
    ir.document
      .blocks
      .iter()
      .all(|block| !matches!(block, Block::Mermaid { .. }))
  );
  assert!(matches!(ir.document.blocks.first(), Some(Block::Callout { .. })));
  assert!(
    ir.document
      .blocks
      .iter()
      .any(|block| matches!(block, Block::UnsupportedBlock { flavour, .. } if flavour == "myoxus:mermaid"))
  );
}

#[test]
fn local_footnotes_project_complete_children_navigation_and_normal_private_assets() {
  let source = include_str!("../../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md");
  let payload = yjs::markdown_to_yjs("Structured footnotes", source).unwrap();
  let mut ir = crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Footnotes", "Page", &payload).unwrap();
  let definitions: Vec<_> = ir
    .document
    .blocks
    .iter()
    .filter_map(|block| match block {
      Block::FootnoteDefinition {
        block_id,
        label,
        children,
        backlinks,
        ..
      } => Some((block_id.clone(), label.clone(), children.clone(), backlinks.clone())),
      _ => None,
    })
    .collect();
  assert_eq!(definitions.len(), 2);
  assert_eq!(definitions[0].1, "Research");
  assert_eq!(definitions[0].2.len(), 8);
  assert_eq!(definitions[0].3.len(), 2);
  assert_ne!(definitions[0].3[0], definitions[0].3[1]);
  assert!(
    matches!(&definitions[0].2[0], Block::Paragraph { text, .. } if text.iter().any(|part| part.bold && part.text == "bold"))
  );
  assert!(matches!(&definitions[0].2[2], Block::Heading { level: 3, .. }));
  assert!(
    matches!(&definitions[0].2[3], Block::List { list, .. } if list.items.len() == 1 && list.items[0].children.len() == 2)
  );
  assert!(matches!(&definitions[0].2[4], Block::Quote { .. }));
  assert!(matches!(&definitions[0].2[5], Block::Code { text, .. } if text.contains("literal[^not-a-reference]")));
  assert!(matches!(&definitions[0].2[6], Block::Image { asset, .. } if asset.source == "media/pixel.svg"));
  assert!(
    matches!(&definitions[0].2[7], Block::Table { rows, .. } if rows.len() == 2 && rows.iter().all(|row| row.len() == 3))
  );
  assert_eq!(definitions[1].3.len(), 1);
  let manifest = crate::apply_private_asset_paths(&mut ir);
  assert_eq!(manifest.len(), 1);
  assert_eq!(manifest[0].source, "media/pixel.svg");
  let html = crate::render_private_document_html(
    &crate::catalog::test_renderer(),
    &ir,
    &crate::PrivateHtmlRenderOptions {
      theme_css_url: "/api/branding/theme.css".into(),
      ..Default::default()
    },
  )
  .unwrap()
  .html;
  assert_eq!(html.matches("role=\"doc-footnote\"").count(), 2);
  assert!(html.contains("<header data-myoxus-footnote-navigation=\"true\">Footnote 1</header>"));
  assert!(!html.contains("aria-label=\"Research\""));
  assert_eq!(html.matches("role=\"doc-noteref\"").count(), 3);
  assert_eq!(html.matches("role=\"doc-backlink\"").count(), 3);
  assert_eq!(html.matches("Definition body with").count(), 1);
  assert!(html.contains(&manifest[0].relative_path));
  assert!(!html.contains("/public-assets/"));
  let mut limits = projection_limits();
  limits.max_text_chars = 100;
  let bounded = document_excerpt_from_yjs(Uuid::nil(), Uuid::nil(), "Footnotes", "Page", &payload, &limits).unwrap();
  assert!(
    bounded
      .diagnostics
      .iter()
      .any(|d| d.code == "preview_excerpt_truncated")
  );
  assert!(
    bounded
      .diagnostics
      .iter()
      .any(|d| d.code == "missing_footnote_definition")
  );
}

#[test]
fn native_note_reference_keeps_its_readable_label_without_public_target_identity() {
  let mut builder = YjsDocumentBuilder::new("Reference");
  let mut marker = YjsTextSegment::plain(" ");
  marker.reference = Some(yjs::MarkdownDocumentReference {
    page_id: "private-target-must-not-leak".into(),
    title: Some("Visible target label".into()),
    description: None,
    params: None,
  });
  builder.push_paragraph(&[marker]);
  let payload = builder.encode();
  let ir = crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Reference", "Page", &payload).unwrap();
  let Block::Paragraph { text, .. } = &ir.document.blocks[0] else {
    panic!("paragraph");
  };
  assert_eq!(text[0].text, "Visible target label");
  assert_eq!(
    text[0].reference.as_ref().unwrap().page_id,
    "private-target-must-not-leak"
  );
  let wire = serde_json::to_string(&ir).unwrap();
  assert!(wire.contains("Visible target label"));
  assert!(!wire.contains("private-target-must-not-leak"));
}

#[test]
fn shared_native_note_placement_and_emitting_order_match_editor_projection() {
  use yrs::updates::decoder::Decode;
  use yrs::{Doc, ReadTxn, StateVector, Update};
  let fixture: serde_json::Value = serde_json::from_str(include_str!(
    "../../../../build/fixtures/contracts/footnote-numbering.json"
  ))
  .unwrap();
  let binary = yjs::markdown_to_yjs("Placement", fixture["source"].as_str().unwrap()).unwrap();
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();
  txn.apply_update(Update::decode_v1(&binary).unwrap()).unwrap();
  let definitions: Vec<_> = blocks
    .iter(&txn)
    .filter_map(|(_, value)| {
      let yrs::Out::YMap(block) = value else { return None };
      let Some(yrs::Out::Any(yrs::Any::String(label))) = block.get(&txn, "prop:label") else {
        return None;
      };
      Some((block, label.to_string()))
    })
    .collect();
  for (block, label) in &definitions {
    match fixture["placements"][label].as_str() {
      Some(placement) => {
        block.insert(&mut txn, "prop:placement", placement);
      }
      None => {
        block.remove(&mut txn, "prop:placement");
      }
    }
  }
  let binary = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);
  let project =
    |binary: &[u8]| crate::document_from_yjs(Uuid::nil(), Uuid::nil(), "Placement", "Page", binary).unwrap();
  let ir = project(&binary);
  assert!(ir.diagnostics.is_empty(), "{:?}", ir.diagnostics);
  let actual: serde_json::Map<_, _> = ir
    .document
    .blocks
    .iter()
    .filter_map(|block| {
      let Block::FootnoteDefinition {
        label,
        placement,
        number,
        reference_order,
        ..
      } = block
      else {
        return None;
      };
      let mut value = serde_json::json!({"placement": placement});
      if let Some(number) = number {
        value["number"] = (*number).into();
      }
      if let Some(order) = reference_order {
        value["order"] = (*order).into();
      }
      Some((label.clone(), value))
    })
    .collect();
  assert_eq!(serde_json::Value::Object(actual), fixture["expected"]);
  let html = crate::render_private_document_html(
    &crate::catalog::test_renderer(),
    &ir,
    &crate::PrivateHtmlRenderOptions {
      theme_css_url: "/api/branding/theme.css".into(),
      ..Default::default()
    },
  )
  .unwrap()
  .html;
  for name in [
    "Endnote 1",
    "Footnote 1",
    "Footnote 4",
    "Footnote 5",
    "Endnote — no reference",
  ] {
    assert!(
      html.contains(&format!(
        "<header data-myoxus-footnote-navigation=\"true\">{name}</header>"
      )),
      "{name}"
    );
  }
  assert_eq!(html.matches("aria-label=\"Footnote 1\"").count(), 3);
  assert!(html.contains("data-myoxus-footnote-placement=\"endnote\""));
  let portable = yjs::extract_text_from_yjs(&binary).unwrap();
  assert!(!portable.extraction_partial);
  assert_eq!(
    portable
      .diagnostics
      .iter()
      .filter(|d| d.code == yjs::MarkdownDiagnosticCode::NormalizedEndnote)
      .count(),
    2
  );
  assert!(portable.markdown.contains("[^Unused]: Retained body."));
  let normalized = yjs::markdown_to_yjs("Reimport", &portable.markdown).unwrap();
  assert!(
    project(&normalized)
      .document
      .blocks
      .iter()
      .filter_map(|block| match block {
        Block::FootnoteDefinition { placement, .. } => Some(placement),
        _ => None,
      })
      .all(|placement| *placement == Some(yjs::footnote::FootnotePlacement::Footnote))
  );
  let mut txn = doc.transact_mut();
  definitions[0].0.insert(&mut txn, "prop:placement", "bad");
  let invalid = txn.encode_state_as_update_v1(&StateVector::default());
  drop(txn);
  assert!(
    project(&invalid)
      .diagnostics
      .iter()
      .any(|d| d.code == "invalid_footnote_placement")
  );
  assert!(yjs::extract_text_from_yjs(&invalid).unwrap_err().contains("placement"));
}
