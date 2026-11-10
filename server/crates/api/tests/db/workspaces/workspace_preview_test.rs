//! Causal REST coverage for private Page previews.

use crate::helpers;
use axum::{
  body::Body,
  http::{Request, StatusCode, header::COOKIE},
};
use http_body_util::BodyExt;
use myoxus_domain::repositories::PdfFontRepository;
use myoxus_infrastructure::pdf_export::PgPdfFontRepository;
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;
use yjs::{
  DOCUMENT_FRAGMENT_SCHEMA, DocumentFragment, DocumentFragmentBlock, DocumentMutation, DocumentTextSegment,
  YjsDocumentBuilder, YjsTextSegment, apply_document_mutation,
};

async fn request(
  app: &axum::Router,
  uri: &str,
  session_id: Option<Uuid>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
  conditional_request(app, uri, session_id, None).await
}

async fn conditional_request(
  app: &axum::Router,
  uri: &str,
  session_id: Option<Uuid>,
  etag: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
  let mut builder = Request::builder().method("GET").uri(uri);
  if let Some(etag) = etag {
    builder = builder.header("if-none-match", etag);
  }
  if let Some(session_id) = session_id {
    builder = builder.header(COOKIE, format!("affine_session={session_id}"));
  }
  let response = app
    .clone()
    .oneshot(builder.body(Body::empty()).expect("preview request"))
    .await
    .expect("preview response");
  let status = response.status();
  let headers = response.headers().clone();
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect preview body")
    .to_bytes()
    .to_vec();
  (status, headers, body)
}

#[test]
fn page_preview_is_authorized_revision_fresh_cached_and_format_safe() {
  helpers::block_on_large_stack("page-preview-rest", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_pdf_admin_repos().await;
    let fonts = PgPdfFontRepository::new(pool.clone());
    for family in ["inter", "jetbrains-mono"] {
      let asset = fonts
        .resolve_theme_font_asset(family)
        .await
        .expect("resolve actual preview font")
        .expect("bundled preview family");
      let style: String = sqlx::query_scalar("SELECT style FROM font_assets WHERE asset_key = $1 AND sha256 = $2")
        .bind(&asset.asset_key)
        .bind(&asset.sha256)
        .fetch_one(&pool)
        .await
        .expect("resolved catalog face");
      assert_eq!(
        style, "normal",
        "family defaults must not select italic assets by filename"
      );
    }
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "preview-owner").await;
    let create = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/graphql")
          .header("content-type", "application/json")
          .header(COOKIE, format!("affine_session={owner_session}"))
          .body(Body::from(
            r#"{"query":"mutation { auth { createWorkspace { id } } }"}"#,
          ))
          .expect("workspace request"),
      )
      .await
      .expect("workspace response");
    let body = create.into_body().collect().await.expect("workspace body").to_bytes();
    let json: Value = serde_json::from_slice(&body).expect("workspace JSON");
    let workspace_id = Uuid::parse_str(
      json["data"]["auth"]["createWorkspace"]["id"]
        .as_str()
        .expect("workspace id"),
    )
    .expect("workspace UUID");
    let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "preview-reader").await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    helpers::add_workspace_member(&pool, workspace_id, reader_id).await;

    let image = base64::Engine::decode(
      &base64::engine::general_purpose::STANDARD,
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    )
    .expect("valid one-pixel PNG");
    let image_key = helpers::upload_blob(
      &app,
      owner_session,
      workspace_id,
      "preview-pixel.png",
      "image/png",
      &image,
    )
    .await;

    let doc_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO docs (id, workspace_id, title, meta, is_workspace_root, public_mode, created_by, updated_by) \
       VALUES ($1, $2, 'Preview contract', '{}'::jsonb, false, 'page', $3, $3)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("insert preview doc");
    let mut source = YjsDocumentBuilder::new("Preview contract");
    source.push_heading(2, &[YjsTextSegment::plain("Current delivery")]);
    source.push_paragraph(&[YjsTextSegment::plain("A server-rendered private Page preview.")]);
    source.push_image(&image_key, "A preview pixel");
    let first_update = source.encode();
    sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 1)")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(&first_update)
      .execute(&pool)
      .await
      .expect("insert initial content");
    let uri = format!("/api/workspaces/{workspace_id}/docs/{doc_id}/preview");

    let (unauthorized, _, _) = request(&app, &uri, None).await;
    assert_eq!(unauthorized, StatusCode::UNAUTHORIZED);

    let (first, concurrent) = tokio::join!(
      request(&app, &uri, Some(reader_session)),
      request(&app, &uri, Some(owner_session))
    );
    let (status, headers, first_svg) = first;
    let (concurrent_status, concurrent_headers, concurrent_svg) = concurrent;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(concurrent_status, StatusCode::OK);
    assert_eq!(concurrent_svg, first_svg);
    let mut cache_states = [
      headers["x-preview-cache"].to_str().expect("first cache state"),
      concurrent_headers["x-preview-cache"]
        .to_str()
        .expect("concurrent cache state"),
    ];
    cache_states.sort_unstable();
    assert_eq!(cache_states, ["hit", "miss"], "same-key requests must coalesce");
    assert_eq!(headers["content-type"], "image/svg+xml");
    assert_eq!(headers["cache-control"], "private, no-cache, must-revalidate");
    let etag = headers["etag"].to_str().expect("artifact validator");
    assert_eq!(headers["etag"], concurrent_headers["etag"]);
    let vary = headers
      .get_all("vary")
      .iter()
      .map(|value| value.to_str().unwrap())
      .collect::<Vec<_>>()
      .join(",")
      .to_ascii_lowercase();
    assert!(vary.contains("cookie") && vary.contains("authorization") && vary.contains("origin"));
    assert_eq!(headers["x-doc-revision"], "1");
    let content_height = headers["x-preview-content-height"]
      .to_str()
      .unwrap()
      .parse::<u32>()
      .unwrap();
    assert!((1..=400).contains(&content_height));
    assert_eq!(headers["x-preview-partial"], "false");
    assert_eq!(headers["x-preview-truncated"], "false");
    let svg = std::str::from_utf8(&first_svg).expect("UTF-8 SVG");
    assert!(svg.contains("viewBox=\"0 0 640 400\""));
    assert!(svg.contains("<path"));
    assert!(svg.contains("data:image/png;base64,"));
    assert!(!svg.contains("<text"));
    assert!(!svg.contains("href=\"http://") && !svg.contains("href=\"https://"));
    assert!(!svg.contains("href=\"file:"));

    sqlx::query("UPDATE doc_updates SET payload = $1 WHERE doc_id = $2 AND workspace_id = $3 AND sequence = 1")
      .bind(vec![0xff_u8, 0x00, 0x7f])
      .bind(doc_id)
      .bind(workspace_id)
      .execute(&pool)
      .await
      .expect("poison persisted payload behind the unchanged cache identity");
    let (warm_status, warm_headers, warm_svg) = request(&app, &uri, Some(reader_session)).await;
    assert_eq!(warm_status, StatusCode::OK);
    assert_eq!(warm_headers["x-preview-cache"], "hit");
    for name in ["x-preview-content-height", "x-preview-partial", "x-preview-truncated"] {
      assert_eq!(
        warm_headers[name], headers[name],
        "warm metadata must reuse the artifact"
      );
    }
    assert_eq!(
      warm_svg, first_svg,
      "warm delivery must reuse the exact artifact without loading or decoding Yjs"
    );
    for validator in [
      etag.to_string(),
      etag.strip_prefix("W/").unwrap_or(etag).to_string(),
      format!("\"other,tag\", {etag}"),
      "*".to_string(),
    ] {
      let (status, conditional_headers, body) =
        conditional_request(&app, &uri, Some(owner_session), Some(&validator)).await;
      assert_eq!(status, StatusCode::NOT_MODIFIED);
      assert!(body.is_empty(), "304 must never transfer an SVG body");
      assert_eq!(conditional_headers["etag"], etag);
      assert_eq!(
        conditional_headers["cache-control"],
        "private, no-cache, must-revalidate"
      );
      assert_eq!(conditional_headers["x-preview-cache"], "hit");
      for name in ["x-preview-content-height", "x-preview-partial", "x-preview-truncated"] {
        assert_eq!(
          conditional_headers[name], headers[name],
          "304 preserves preview metadata"
        );
      }
      assert_eq!(
        conditional_headers["content-security-policy"],
        headers["content-security-policy"]
      );
      assert_eq!(conditional_headers["x-content-type-options"], "nosniff");
    }
    let (denied, _, _) = conditional_request(&app, &uri, Some(admin_session), Some(etag)).await;
    assert_eq!(
      denied,
      StatusCode::FORBIDDEN,
      "an unrelated account cannot validate private output"
    );
    let (status, _, unmatched) = conditional_request(&app, &uri, Some(owner_session), Some("\"unknown\"")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(unmatched, first_svg);
    sqlx::query("UPDATE doc_updates SET payload = $1 WHERE doc_id = $2 AND workspace_id = $3 AND sequence = 1")
      .bind(&first_update)
      .bind(doc_id)
      .bind(workspace_id)
      .execute(&pool)
      .await
      .expect("restore persisted payload after the warm-hit probe");

    let invalid_config = helpers::gql(
      &app,
      admin_session,
      serde_json::json!({
        "query": "mutation U($u:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$u){applied fieldErrors{path}}}}",
        "variables": {"u": [{"module": "preview", "key": "max_projected_blocks", "value": 1000001}]}
      }),
    )
    .await;
    assert_eq!(invalid_config["data"]["admin"]["adminUpdateConfig"]["applied"], false);

    let live_config = helpers::gql(
      &app,
      admin_session,
      serde_json::json!({
        "query": "mutation U($u:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$u){applied fieldErrors{path}}}}",
        "variables": {"u": [{"module": "preview", "key": "max_text_chars", "value": 1}]}
      }),
    )
    .await;
    assert_eq!(live_config["data"]["admin"]["adminUpdateConfig"]["applied"], true);
    let (limited_status, limited_headers, limited_svg) = request(&app, &uri, Some(reader_session)).await;
    assert_eq!(limited_status, StatusCode::OK);
    assert_eq!(limited_headers["x-preview-cache"], "miss");
    assert_ne!(limited_svg, first_svg, "live limits must affect the actual renderer");

    let reset_config = helpers::gql(
      &app,
      admin_session,
      serde_json::json!({
        "query": "mutation U($u:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$u){applied fieldErrors{path}}}}",
        "variables": {"u": [{"module": "preview", "key": "max_text_chars", "value": null}]}
      }),
    )
    .await;
    assert_eq!(reset_config["data"]["admin"]["adminUpdateConfig"]["applied"], true);
    let (reset_status, reset_headers, reset_svg) = request(&app, &uri, Some(reader_session)).await;
    assert_eq!(reset_status, StatusCode::OK);
    assert_eq!(reset_headers["x-preview-cache"], "hit");
    assert_eq!(
      reset_svg, first_svg,
      "removing an override must recover the file baseline"
    );

    sqlx::query("UPDATE blobs SET deleted_at = now(), updated_at = now() WHERE workspace_id = $1 AND key = $2")
      .bind(workspace_id)
      .bind(&image_key)
      .execute(&pool)
      .await
      .expect("remove referenced image");
    let (media_status, media_headers, media_svg) =
      conditional_request(&app, &uri, Some(reader_session), Some(etag)).await;
    assert_eq!(media_status, StatusCode::OK);
    assert_eq!(media_headers["x-preview-cache"], "miss");
    assert_ne!(media_svg, first_svg, "removed media must invalidate a cached artifact");

    assert_ne!(media_headers["etag"], etag);
    sqlx::query("UPDATE blobs SET deleted_at = NULL, updated_at = now() WHERE workspace_id = $1 AND key = $2")
      .bind(workspace_id)
      .bind(&image_key)
      .execute(&pool)
      .await
      .expect("restore completed image");
    let (restored_status, restored_headers, restored_svg) = conditional_request(
      &app,
      &uri,
      Some(reader_session),
      Some(media_headers["etag"].to_str().unwrap()),
    )
    .await;
    assert_eq!(restored_status, StatusCode::OK);
    assert_eq!(restored_headers["x-preview-cache"], "miss");
    assert_eq!(
      restored_svg, first_svg,
      "an absent image becoming available must invalidate the cached excerpt"
    );
    assert_eq!(
      restored_headers["etag"], etag,
      "the same bytes have the same validator after regeneration"
    );

    let (dark_status, dark_headers, dark_svg) = conditional_request(
      &app,
      &format!("{uri}?colorScheme=dark"),
      Some(reader_session),
      Some(etag),
    )
    .await;
    assert_eq!(dark_status, StatusCode::OK);
    assert_ne!(dark_svg, first_svg);
    assert_ne!(dark_headers["etag"], etag);

    sqlx::query("INSERT INTO theme_profiles (scope, workspace_id, theme_id, theme_mode) SELECT 'workspace', $1, theme_id, 'dark' FROM theme_profiles WHERE scope = 'global'")
      .bind(workspace_id).execute(&pool).await.expect("set workspace theme mode");
    let (theme_status, theme_headers, theme_svg) =
      conditional_request(&app, &uri, Some(reader_session), Some(etag)).await;
    assert_eq!(
      theme_status,
      StatusCode::OK,
      "a changed server theme must not validate old bytes at the same URL"
    );
    assert_ne!(theme_headers["etag"], etag);
    assert_eq!(theme_svg, dark_svg);
    sqlx::query("DELETE FROM theme_profiles WHERE workspace_id = $1")
      .bind(workspace_id)
      .execute(&pool)
      .await
      .expect("restore inherited workspace theme");

    // Edit the existing tree causally. Merging an independently built document
    // adds a competing page root whose random ID may leave the old root selected.
    let tail = apply_document_mutation(
      &first_update,
      &DocumentMutation::ReplaceAll {
        fragment: DocumentFragment {
          schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
          blocks: vec![DocumentFragmentBlock::Paragraph {
            properties: None,
            text: vec![DocumentTextSegment {
              text: "This update exists only in the ordered tail.".to_string(),
              ..Default::default()
            }],
          }],
        },
      },
    )
    .expect("edit existing preview document");
    sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 2)")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(tail.delta)
      .execute(&pool)
      .await
      .expect("insert update-only edit");
    let (fresh_status, fresh_headers, fresh_svg) =
      conditional_request(&app, &uri, Some(reader_session), Some(etag)).await;
    assert_eq!(fresh_status, StatusCode::OK);
    assert_eq!(fresh_headers["x-doc-revision"], "2");
    assert_eq!(fresh_headers["x-preview-cache"], "miss");
    assert_ne!(
      fresh_svg, first_svg,
      "update-only edits must change the preview artifact"
    );

    // Native fields are ordinary content, while their current output is not.
    // Exercise warm invalidation for profiles and canonical metadata separately
    // from the source revision; glyph paths alone cannot expose a token leak.
    let native = yrs::Doc::new();
    use yrs::{Map, ReadTxn, Text, Transact, updates::decoder::Decode};
    let blocks = native.get_or_insert_map("blocks");
    let field_update = {
      let merged = yjs::merge_updates(vec![first_update.clone(), tail.state.clone()]).unwrap();
      let mut txn = native.transact_mut();
      txn.apply_update(yrs::Update::decode_v1(&merged).unwrap()).unwrap();
      let before = txn.state_vector();
      let text = blocks
        .iter(&txn)
        .find_map(|(_, value)| {
          let yrs::Out::YMap(block) = value else { return None };
          let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
            return None;
          };
          Some(text)
        })
        .unwrap();
      let length = text.len(&txn);
      text.remove_range(&mut txn, 0, length);
      for (index, key) in ["createdBy", "documentNumber"].iter().enumerate() {
        let descriptor = serde_json::json!({"type":"metadata","id":format!("field-{index}"),"key":key,
          "format":if *key == "createdBy" { "name" } else { "text" }});
        let at = text.len(&txn);
        text.insert_with_attributes(
          &mut txn,
          at,
          " ",
          yrs::types::Attrs::from([(
            "documentField".into(),
            yrs::Any::from_json(&descriptor.to_string()).unwrap(),
          )]),
        );
        text.insert_with_attributes(&mut txn, at + 1, " · ", Default::default());
      }
      txn.encode_state_as_update_v1(&before)
    };
    sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 3)")
      .bind(doc_id)
      .bind(workspace_id)
      .bind(&field_update)
      .execute(&pool)
      .await
      .unwrap();
    let (field_status, field_headers, field_svg) = request(&app, &uri, Some(reader_session)).await;
    assert_eq!(field_status, StatusCode::OK);
    assert_eq!(field_headers["x-doc-revision"], "3");
    sqlx::query("UPDATE users SET name='Actual preview author renamed' WHERE id=$1")
      .bind(owner_id)
      .execute(&pool)
      .await
      .unwrap();
    let (profile_status, profile_headers, profile_svg) = conditional_request(
      &app,
      &uri,
      Some(reader_session),
      Some(field_headers["etag"].to_str().unwrap()),
    )
    .await;
    assert_eq!(profile_status, StatusCode::OK);
    assert_eq!(profile_headers["x-preview-cache"], "miss");
    assert_ne!(
      profile_svg, field_svg,
      "renamed profiles must invalidate warm glyph output without a metadata/content change"
    );
    sqlx::query("UPDATE docs SET document_number='PREVIEW-0042', metadata_revision=metadata_revision+1 WHERE id=$1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .unwrap();
    let (metadata_status, metadata_headers, metadata_svg) = conditional_request(
      &app,
      &uri,
      Some(reader_session),
      Some(profile_headers["etag"].to_str().unwrap()),
    )
    .await;
    assert_eq!(metadata_status, StatusCode::OK);
    assert_ne!(metadata_svg, profile_svg);
    let (warm_status, warm_headers, warm_svg) = request(&app, &uri, Some(owner_session)).await;
    assert_eq!(warm_status, StatusCode::OK);
    assert_eq!(warm_headers["x-preview-cache"], "hit");
    assert_eq!(warm_svg, metadata_svg);
    assert_eq!(warm_headers["etag"], metadata_headers["etag"]);
    let (writes, last): (i64, i64) = sqlx::query_as("SELECT count(*), max(sequence) FROM doc_updates WHERE doc_id=$1")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!((writes, last), (3, 3), "current field output must never write Yjs");

    let (png_status, png_headers, png) = request(&app, &format!("{uri}?format=png"), Some(reader_session)).await;
    assert_eq!(png_status, StatusCode::OK);
    assert_eq!(png_headers["content-type"], "image/png");
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    let (invalid_format, invalid_headers, invalid_body) =
      request(&app, &format!("{uri}?format=jpeg"), Some(reader_session)).await;
    assert_eq!(invalid_format, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_headers["cache-control"], "private, no-store");
    let invalid_json: Value = serde_json::from_slice(&invalid_body).expect("structured preview error");
    assert_eq!(invalid_json["code"], "invalid_format");

    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2")
      .bind(workspace_id)
      .bind(reader_id)
      .execute(&pool)
      .await
      .expect("revoke reader");
    let (denied, _, _) = conditional_request(&app, &uri, Some(reader_session), Some("*")).await;
    assert_eq!(
      denied,
      StatusCode::FORBIDDEN,
      "a warm cache must not bypass revoked access"
    );

    helpers::add_workspace_member(&pool, workspace_id, reader_id).await;
    sqlx::query("UPDATE docs SET deleted_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&pool)
      .await
      .expect("delete preview document");
    let (deleted, _, _) = conditional_request(&app, &uri, Some(reader_session), Some("*")).await;
    assert_eq!(deleted, StatusCode::FORBIDDEN, "a warm cache must not bypass deletion");

    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[owner_id, reader_id, admin_id]).await;
  });
}
