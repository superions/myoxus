// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! P0-02 transport-boundary regressions.
//!
//! These tests deliberately cross the HTTP and GraphQL boundaries. A
//! PermissionService unit test cannot prove that a handler checked the
//! resolved document before loading payloads, history or attachment storage.

use crate::helpers;
use axum::{
  body::Body,
  http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use myoxus_application::auth::AuthStore;
use myoxus_application::permission::AccessController;
use myoxus_infrastructure::auth::SqlxAuthStore;
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[test]
fn docx_import_creates_one_populated_page_and_denies_readonly_creation() {
  helpers::block_on_large_stack("docx-import-page-acl", || async {
    let (app, pool, auth_store, state) = helpers::setup_app_with_config_override_and_state(|config| {
      config.cors.allowed_origins.push("https://docx-client.example".into());
    })
    .await;
    let (owner, owner_session) = helpers::seed_user(&pool, &auth_store, "docx_import_owner").await;
    let (reader, reader_session) = helpers::seed_user(&pool, &auth_store, "docx_import_reader").await;
    let workspace = helpers::create_workspace(&pool, owner).await;
    helpers::create_workspace_root_doc(&pool, workspace, owner).await;
    add_workspace_role(&pool, workspace, reader, "Reader").await;
    let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6380".into());
    let mut broadcasts = redis::Client::open(redis_url)
      .unwrap()
      .get_async_pubsub()
      .await
      .unwrap();
    broadcasts
      .psubscribe(format!("*:ws:broadcast:{workspace}"))
      .await
      .unwrap();
    let mut source = wordcraft_doc::Document::from_text("This content must survive the import");
    source.core.title = "Imported Word title".into();
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAQCAIAAAAphe5+AAAANklEQVR4nO3PQQkAMAzAwMqb7EmriD2OQSACLjPn/p0XNKAFDWhBA1rQgBY0oAUNaEEDWvDWAoEhID07ckR4AAAAAElFTkSuQmCC").unwrap();
    source
      .media
      .insert("figure.png".into(), std::sync::Arc::new(png.clone()));
    let mut figure = wordcraft_doc::Paragraph::new();
    figure
      .insert_object(
        0,
        wordcraft_doc::InlineObject::Image {
          media: "figure.png".into(),
          w: 48.0,
          h: 12.0,
          alt: "Source figure".into(),
          float: Default::default(),
          crop: [0.0; 4],
          fx: Default::default(),
          ole: None,
        },
        &wordcraft_doc::CharProps::default(),
      )
      .unwrap();
    source.body.push(wordcraft_doc::para_block(figure));
    let bytes = wordcraft_docx::write(&source).expect("real Word package");
    let boundary = "myoxus-docx-import-boundary";
    let upload = |content: &[u8]| {
      let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"source.docx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n").into_bytes();
      body.extend_from_slice(content);
      body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
      body
    };
    let request = |session, body: Vec<u8>| {
      Request::builder()
        .method("POST")
        .uri(format!("/api/workspaces/{workspace}/docs/import/docx"))
        .header("cookie", format!("affine_session={session}"))
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .unwrap()
    };

    let denied = app
      .clone()
      .oneshot(request(reader_session, upload(&bytes)))
      .await
      .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let invalid = app
      .clone()
      .oneshot(request(owner_session, upload(b"not a Word archive")))
      .await
      .unwrap();
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let created = app
      .clone()
      .oneshot(request(owner_session, upload(&bytes)))
      .await
      .unwrap();
    let status = created.status();
    let json: serde_json::Value =
      serde_json::from_slice(&created.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status, StatusCode::CREATED, "{json}");
    assert_eq!(json["title"], "Imported Word title");
    assert_eq!(json["bestEffort"], true);
    let key = json["id"].as_str().expect("ordinary page key");
    use futures_util::StreamExt as _;
    let mut stream = broadcasts.on_message();
    let delivery = tokio::time::timeout(std::time::Duration::from_secs(5), async {
      let mut delivered = Vec::new();
      for _ in 0..4 {
        let message = stream.next().await.ok_or("broadcast subscription closed")?;
        let payload = message
          .get_payload::<String>()
          .map_err(|_| "invalid broadcast payload")?;
        let value: myoxus_infrastructure::redis::workspace_broadcast::CrossInstanceBroadcast =
          serde_json::from_str(&payload).map_err(|_| "invalid broadcast envelope")?;
        delivered.push(value);
      }
      Ok::<_, &str>(delivered)
    })
    .await;
    drop(stream);
    drop(broadcasts);
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!("/api/workspaces/{workspace}/docs/{key}"))
          .header("cookie", format!("affine_session={owner_session}"))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot = response.into_body().collect().await.unwrap().to_bytes();
    let extracted = yjs::extract_text_from_yjs(&snapshot).expect("created editable snapshot");
    assert!(extracted.markdown.contains("This content must survive the import"));
    let page_count: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id = $1 AND is_workspace_root = false AND title = 'Imported Word title'")
      .bind(workspace).fetch_one(&pool).await.unwrap();
    assert_eq!(page_count, 1, "denied and malformed requests must not create a page");

    let export_request = |session| {
      Request::builder()
        .method("POST")
        .uri(format!("/api/workspaces/{workspace}/docs/{key}/export/docx"))
        .header("origin", "https://docx-client.example")
        .header("cookie", format!("affine_session={session}"))
        .body(Body::empty())
        .unwrap()
    };
    let exported = app.clone().oneshot(export_request(reader_session)).await.unwrap();
    let status = exported.status();
    let headers = exported.headers().clone();
    let bytes = exported.into_body().collect().await.unwrap().to_bytes();
    for key in state.blob().list_all_workspace_blob_keys(workspace).await.unwrap() {
      state
        .blob()
        .delete_imported_blob(workspace, &key)
        .await
        .expect("remove only this test's media");
    }
    let media_directory = std::path::Path::new("test-storage").join(workspace.to_string());
    if media_directory.exists() {
      std::fs::remove_dir_all(media_directory).expect("remove this test's empty workspace storage directories");
    }
    let delivered = delivery
      .expect("committed DOCX must publish live leaf/root updates")
      .expect("broadcast subscription must remain valid");
    let root_key = workspace.to_string();
    assert_eq!(
      delivered
        .iter()
        .map(|value| value.payload["docId"].as_str().unwrap())
        .collect::<Vec<_>>(),
      vec![key, key, root_key.as_str(), root_key.as_str()]
    );
    assert_eq!(
      delivered.iter().map(|value| value.event.as_str()).collect::<Vec<_>>(),
      vec![
        "space:broadcast-doc-update",
        "space:broadcast-doc-updates",
        "space:broadcast-doc-update",
        "space:broadcast-doc-updates"
      ]
    );
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&bytes));
    assert_eq!(headers["access-control-allow-origin"], "https://docx-client.example");
    let exposed = headers["access-control-expose-headers"].to_str().unwrap();
    assert!(exposed.contains("x-myoxus-conversion-warnings") && exposed.contains("content-disposition"));
    assert_eq!(
      headers["content-type"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    assert!(
      headers["content-disposition"]
        .to_str()
        .unwrap()
        .contains("Imported%20Word%20title.docx")
    );
    assert!(
      serde_json::from_str::<Vec<serde_json::Value>>(headers["x-myoxus-conversion-warnings"].to_str().unwrap())
        .unwrap()
        .is_empty()
    );
    let word = wordcraft_docx::read(&bytes).expect("actual server file");
    assert!(
      word.media.values().any(|bytes| bytes.as_ref() == &png),
      "HTTP export must include original private image bytes"
    );
    assert!(
      wordcraft_docx::embedded_fonts(&word)
        .iter()
        .any(|font| font.name == "Inter" && !font.data.is_empty()),
      "The HTTP download must carry its resolved theme font bytes"
    );
    assert_eq!(word.core.title, "Imported Word title");
    assert!(word.body.iter().any(|block| matches!(&**block, wordcraft_doc::Block::Para(paragraph) if paragraph.plain_text().contains("This content must survive the import"))));
    // Target authorization is independent of permission to export the source.
    // A cached native alias must not expose an inaccessible document's title.
    let readable_target = helpers::create_doc(&pool, workspace, owner).await;
    let readable_key: String = sqlx::query_scalar("SELECT external_id FROM docs WHERE id=$1")
      .bind(readable_target)
      .fetch_one(&pool)
      .await
      .unwrap();
    let private_workspace = helpers::create_workspace(&pool, owner).await;
    let private_target = helpers::create_doc(&pool, private_workspace, owner).await;
    let private_key: String = sqlx::query_scalar("SELECT external_id FROM docs WHERE id=$1")
      .bind(private_target)
      .fetch_one(&pool)
      .await
      .unwrap();
    let mut reference_source = yjs::YjsDocumentBuilder::new("References");
    let mut allowed = yjs::YjsTextSegment::plain(" ");
    allowed.reference = Some(yjs::MarkdownDocumentReference {
      page_id: readable_key.clone(),
      title: Some("Allowed visible alias".into()),
      description: None,
      params: Some(serde_json::json!({"blockIds":["target-block"]})),
    });
    let mut denied = yjs::YjsTextSegment::plain(" ");
    denied.reference = Some(yjs::MarkdownDocumentReference {
      page_id: private_key.clone(),
      title: Some("PRIVATE CACHED TARGET TITLE".into()),
      description: None,
      params: None,
    });
    let mut malformed = yjs::YjsTextSegment::plain(" ");
    malformed.reference = Some(yjs::MarkdownDocumentReference {
      page_id: readable_key.clone(),
      title: Some("PRIVATE MALFORMED SCOPE".into()),
      description: None,
      params: None,
    });
    reference_source.push_paragraph(&[
      yjs::YjsTextSegment::plain("Reference source "),
      allowed,
      denied,
      malformed,
    ]);
    let scoped_snapshot = {
      use yrs::updates::decoder::Decode;
      use yrs::{Map, ReadTxn, Text, Transact};
      let document = yrs::Doc::new();
      let blocks = document.get_or_insert_map("blocks");
      let mut txn = document.transact_mut();
      txn
        .apply_update(yrs::Update::decode_v1(&reference_source.encode()).unwrap())
        .unwrap();
      let texts = blocks
        .iter(&txn)
        .filter_map(|(_, block)| match block {
          yrs::Out::YMap(block) => block.get(&txn, "prop:text"),
          _ => None,
        })
        .filter_map(|value| match value {
          yrs::Out::YText(text) => Some(text),
          _ => None,
        })
        .collect::<Vec<_>>();
      for text in texts {
        let mut offset = 0;
        for run in text.diff(&txn, |_| ()) {
          let length = match &run.insert {
            yrs::Out::Any(yrs::Any::String(text)) => text.len() as u32,
            _ => 1,
          };
          if let Some(yrs::Any::Map(reference)) = run.attributes.as_deref().and_then(|attrs| attrs.get("reference")) {
            let mut reference = (**reference).clone();
            let scope = if reference.get("pageId") == Some(&yrs::Any::String(private_key.clone().into())) {
              Some(yrs::Any::String(private_workspace.to_string().into()))
            } else if reference.get("title") == Some(&yrs::Any::String("PRIVATE MALFORMED SCOPE".into())) {
              Some(yrs::Any::Null)
            } else {
              None
            };
            if let Some(scope) = scope {
              reference.insert("workspaceId".into(), scope);
              text.format(
                &mut txn,
                offset,
                length,
                yrs::types::Attrs::from([("reference".into(), yrs::Any::Map(std::sync::Arc::new(reference)))]),
              );
            }
          }
          offset += length;
        }
      }
      txn.encode_state_as_update_v1(&yrs::StateVector::default())
    };
    // Metadata-only references must not require reading/archiving file bodies.
    // Their workspace-scoped authority is separate from the source Page ACL.
    let media = [
      (
        format!("docx-file-{}", Uuid::new_v4()),
        workspace,
        "text/plain",
        "Visible file.txt",
      ),
      (
        format!("docx-audio-{}", Uuid::new_v4()),
        workspace,
        "audio/wav",
        "Visible audio.wav",
      ),
      (
        format!("docx-video-{}", Uuid::new_v4()),
        workspace,
        "video/mp4",
        "Visible video.mp4",
      ),
      (
        format!("docx-private-{}", Uuid::new_v4()),
        private_workspace,
        "text/plain",
        "PRIVATE BLOB CACHED NAME",
      ),
    ];
    for (key, scope, mime, _) in &media {
      sqlx::query("INSERT INTO blobs (workspace_id,key,size,mime,status) VALUES ($1,$2,5,$3,'completed')")
        .bind(scope)
        .bind(key)
        .bind(mime)
        .execute(&pool)
        .await
        .unwrap();
    }
    let scoped_snapshot = yjs::append_imported_attachments(
      &scoped_snapshot,
      &media
        .iter()
        .map(|(key, _, mime, name)| yjs::ImportedAttachment {
          source_id: key.clone(),
          name: (*name).into(),
          mime: (*mime).into(),
          size: 5,
        })
        .collect::<Vec<_>>(),
    )
    .unwrap();
    let (reference_doc, _) = state
      .doc()
      .create_page_from_snapshot_with_sync_updates(workspace, owner, Some("References".into()), scoped_snapshot)
      .await
      .unwrap();
    let references = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri(format!(
            "/api/workspaces/{workspace}/docs/{}/export/docx",
            reference_doc.external_id
          ))
          .header("cookie", format!("affine_session={reader_session}"))
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(references.status(), StatusCode::OK);
    let warnings: serde_json::Value = serde_json::from_str(
      references
        .headers()
        .get("x-myoxus-conversion-warnings")
        .unwrap()
        .to_str()
        .unwrap(),
    )
    .unwrap();
    assert!(
      warnings
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning["code"] == "media_reference_normalized" && warning["count"] == 3)
    );
    assert!(
      warnings
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning["code"] == "media_reference_omitted" && warning["count"] == 1)
    );
    let reference_bytes = references.into_body().collect().await.unwrap().to_bytes();
    let reference_word = wordcraft_docx::read(&reference_bytes).unwrap();
    let paragraphs = reference_word
      .body
      .iter()
      .filter_map(|block| match &**block {
        wordcraft_doc::Block::Para(paragraph) => Some(paragraph),
        _ => None,
      })
      .collect::<Vec<_>>();
    let reference_text = paragraphs
      .iter()
      .map(|paragraph| paragraph.final_text())
      .collect::<String>();
    assert!(reference_text.contains("Allowed visible alias") && reference_text.contains("[Unavailable document]"));
    assert!(!reference_text.contains("PRIVATE CACHED TARGET TITLE"));
    assert!(!reference_text.contains("PRIVATE MALFORMED SCOPE"));
    for label in [
      "Attachment: Visible file.txt",
      "Audio: Visible audio.wav",
      "Video: Visible video.mp4",
    ] {
      assert!(reference_text.contains(label), "{label}");
    }
    assert_eq!(
      reference_text.matches("Binary/player is not embedded in Word.").count(),
      4
    );
    assert!(reference_text.contains("[Attachment unavailable]"));
    assert!(!reference_text.contains("PRIVATE BLOB CACHED NAME"));
    assert!(
      reference_word.media.is_empty(),
      "A Word reference is not an attachment archive"
    );
    let destinations = paragraphs
      .iter()
      .flat_map(|paragraph| &paragraph.runs)
      .filter_map(|run| run.props.link.as_deref())
      .collect::<String>();
    for (key, _, _, _) in &media {
      assert!(
        !reference_text.contains(key) && !destinations.contains(key),
        "Private blob keys must never become Word labels or URLs"
      );
    }
    assert!(destinations.contains(&format!(
      "/workspace/{workspace}/{}?blockIds=",
      reference_doc.external_id
    )));
    for (key, scope, _, _) in &media {
      sqlx::query("DELETE FROM blobs WHERE workspace_id=$1 AND key=$2")
        .bind(scope)
        .bind(key)
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(reference_text.matches("[Unavailable document]").count(), 2);
    assert!(
      paragraphs.iter().flat_map(|paragraph| &paragraph.runs).any(|run| run
        .props
        .link
        .as_deref()
        .is_some_and(|url| url.contains(&format!("/workspace/{workspace}/{readable_key}"))
          && url.contains("blockIds=target-block")))
    );
    sqlx::query("UPDATE workspace_memberships SET role = 'External' WHERE workspace_id = $1 AND user_id = $2")
      .bind(workspace)
      .bind(reader)
      .execute(&pool)
      .await
      .unwrap();
    let denied_export = app.clone().oneshot(export_request(reader_session)).await.unwrap();
    assert_eq!(denied_export.status(), StatusCode::FORBIDDEN);

    helpers::cleanup_users(&pool, &[owner, reader]).await;
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE id = $1")
      .bind(workspace)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(remaining, 0, "import test must not leave a workspace behind");
  });
}

async fn add_workspace_role(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, role: &str) {
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(role)
  .execute(pool)
  .await
  .expect("workspace role must be persisted");
}

async fn add_doc_role(pool: &PgPool, doc_id: Uuid, user_id: Uuid, role: &str) {
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, $3)")
    .bind(user_id)
    .bind(doc_id)
    .bind(role)
    .execute(pool)
    .await
    .expect("document role must be persisted");
}

/// Exercise the SQLx implementation of the P0 bulk role contract against the
/// migrated schema, including the no-query-equivalent empty input behavior.
#[test]
fn sqlx_bulk_document_roles_returns_only_explicit_overrides() {
  helpers::block_on_large_stack("p002-bulk-role-sql", || async {
    let pool = helpers::setup_pool().await;
    let owner_id = helpers::create_user(&pool, "p002_bulk_owner", false).await;
    let granted_id = helpers::create_user(&pool, "p002_bulk_granted", false).await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let first_doc = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let second_doc = helpers::create_doc(&pool, workspace_id, owner_id).await;
    add_doc_role(&pool, first_doc, granted_id, "Reader").await;

    let store = SqlxAuthStore::from_pool(pool.clone());
    let roles = store
      .get_doc_roles_bulk(granted_id, &[first_doc, second_doc])
      .await
      .expect("bulk SQL role read");
    assert_eq!(roles.get(&first_doc), Some(&myoxus_domain::entities::DocRole::Reader));
    assert!(
      !roles.contains_key(&second_doc),
      "bulk role read must omit absent overrides"
    );
    assert!(
      store
        .get_doc_roles_bulk(granted_id, &[])
        .await
        .expect("empty bulk SQL role read")
        .is_empty(),
      "empty bulk role read must return an empty map"
    );

    helpers::cleanup_users(&pool, &[owner_id, granted_id]).await;
  });
}

fn graphql_errors(value: &serde_json::Value) -> bool {
  value
    .get("errors")
    .and_then(serde_json::Value::as_array)
    .is_some_and(|errors| !errors.is_empty())
}

/// A reader can resolve document metadata, but the permanent-delete mutation
/// must still fail at the document action boundary.
#[test]
fn reader_can_resolve_metadata_but_cannot_hard_delete() {
  helpers::block_on_large_stack("p002-reader-hard-delete", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_transport_owner").await;
    let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "p002_transport_reader").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, reader_id, "Reader").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

    let loaded = helpers::gql(
    &app,
    reader_session,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
    assert!(!graphql_errors(&loaded), "reader metadata load must succeed: {loaded}");
    assert_eq!(loaded["data"]["workspace"]["doc"]["id"], doc_id.to_string());

    let denied_delete = helpers::gql(
    &app,
    reader_session,
    json!({
      "query": "mutation($input: DeleteDocumentPermanentlyInput!) { deleteDocumentPermanently(input: $input) { deleted } }",
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() } }
    }),
  )
  .await;
    assert!(
      graphql_errors(&denied_delete),
      "reader hard-delete must be denied: {denied_delete}"
    );
    let still_present: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("document existence query");
    assert!(still_present, "denied reader delete must not remove the document");

    let permission = myoxus_application::permission::PermissionService::new(auth_store.clone());
    let resource = myoxus_application::permission::DocResource {
      user_id: reader_id,
      workspace_id,
      doc_id,
    };
    assert!(
      !permission
        .can(&resource, myoxus_domain::permission::DocAction::Update)
        .await
    );
    assert!(
      !permission
        .can(&resource, myoxus_domain::permission::DocAction::Delete)
        .await
    );

    helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
    let _ = owner_session;
  });
}

/// An External workspace member keeps workspace-level visibility for list
/// surfaces, but receives no document payload through any normal read route
/// when no explicit document role exists.
#[test]
fn external_cannot_read_payload_history_search_timestamp_or_attachment() {
  helpers::block_on_large_stack("p002-external-transport", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_template_registry_and_search_service().await;
    let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "p002_external_owner").await;
    let (external_id, external_session) = helpers::seed_user(&pool, &auth_store, "p002_external_reader").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, external_id, "External").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let doc_key = doc_id.to_string();

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/docs/{doc_key}"),
    )
    .await;
    assert_eq!(status, 403, "payload read must be denied before the doc load");

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/docs/{doc_key}/histories/0"),
    )
    .await;
    assert_eq!(
      status, 403,
      "history read must be denied before timestamp parsing/storage"
    );

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/rpc/workspaces/{workspace_id}/docs/{doc_key}/content"),
    )
    .await;
    assert_eq!(
      status, 403,
      "RPC content read must be denied before SQL payload projection"
    );

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/docs/{doc_key}/comment-attachments/missing"),
    )
    .await;
    assert_eq!(status, 403, "comment attachment read must be denied by document ACL");

    crate::document_event_acl_test::assert_workspace_timestamp_denied(
      &app,
      &format!("affine_session={external_session}"),
      workspace_id,
    )
    .await;

    let (status, search) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/search?q=secret"),
    )
    .await;
    assert_eq!(status, 200, "workspace search remains a valid filtered response");
    assert!(
      search["items"].as_array().is_some_and(Vec::is_empty),
      "search must omit unreadable documents rather than projecting their snippets: {search}"
    );

    helpers::cleanup_users(&pool, &[owner_id, external_id]).await;
  });
}

/// The workspace root is authorized by the resolved document identity, not by
/// a client-visible prefix or by workspace membership alone.
#[test]
fn workspace_root_obeys_doc_action_without_prefix_bypass() {
  helpers::block_on_large_stack("p002-workspace-root", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_root_owner").await;
    let (external_id, external_session) = helpers::seed_user(&pool, &auth_store, "p002_root_external").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, external_id, "External").await;

    sqlx::query(
    "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by) VALUES ($1, $2, $1, 'Workspace Root', TRUE, $3, $3)",
  )
  .bind(workspace_id)
  .bind(workspace_id.to_string())
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("workspace root must be persisted");

    let owner_view = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": workspace_id.to_string() }
    }),
  )
  .await;
    assert!(
      !graphql_errors(&owner_view),
      "owner must read the workspace root: {owner_view}"
    );

    let external_view = helpers::gql(
    &app,
    external_session,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": workspace_id.to_string() }
    }),
  )
  .await;
    assert!(
      graphql_errors(&external_view),
      "workspace root must not bypass document ACL: {external_view}"
    );

    helpers::cleanup_users(&pool, &[owner_id, external_id]).await;
  });
}
