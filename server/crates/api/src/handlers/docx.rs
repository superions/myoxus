// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Authenticated DOCX conversion using workspace page lifecycle and document ACL owners.

use std::sync::{Arc, OnceLock};

use axum::{
  Json,
  extract::{Multipart, Path, State, multipart::MultipartRejection},
  http::{HeaderMap, StatusCode},
  response::{IntoResponse, Response},
};
use myoxus_application::doc::DocSpaceKind;
use myoxus_application::{
  docx::{self, ImportError},
  permission::{AccessController, WorkspaceResource},
};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::state::ApiState;

const MAX_UPLOAD: usize = 100 * 1024 * 1024;
static IMPORT_PERMITS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static EXPORT_PERMITS: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxErrorBody {
  code: &'static str,
  message: &'static str,
}

async fn export_fonts(state: &ApiState, workspace: Uuid) -> Result<docx::ExportFonts, ImportError> {
  let pool = state.metrics_pool().ok_or(ImportError::Conversion)?;
  let profile = myoxus_infrastructure::branding::load_effective_theme_profile(&pool, Some(workspace))
    .await
    .map_err(|_| ImportError::Conversion)?;
  let mut families = Vec::new();
  for role in ["body", "heading", "mono"] {
    let style = profile
      .theme
      .typography_styles
      .iter()
      .find(|style| style.pdf_role.as_deref() == Some(role))
      .ok_or(ImportError::Conversion)?;
    if style.font_family.trim().is_empty() {
      return Err(ImportError::Conversion);
    }
    families.push(style.font_family.clone());
  }
  let mut typography = std::collections::BTreeMap::new();
  for (word_style, source_key) in [
    ("Normal", "body.default"),
    ("Heading1", "heading.h1"),
    ("Heading2", "heading.h2"),
    ("Heading3", "heading.h3"),
    ("Heading4", "heading.h4"),
    ("Heading5", "heading.h5"),
    ("Heading6", "heading.h5"),
    ("MyoxusEyebrow", "label.compact"),
    ("Quote", "quote.block"),
    ("MyoxusCode", "code.block"),
    ("Caption", "body.small"),
  ] {
    if let Some(style) = profile
      .theme
      .typography_styles
      .iter()
      .find(|style| style.style_key == source_key)
    {
      let projected = myoxus_infrastructure::pdf_export::theme::resolve_pdf_typography_role("body", Some(style))
        .map_err(|_| ImportError::Conversion)?;
      typography.insert(
        word_style.to_string(),
        docx::ExportTypography {
          family: style.font_family.clone(),
          style: projected,
        },
      );
    }
  }
  let mode = if profile.theme_mode == "dark" { "dark" } else { "light" };
  let colors = profile.theme.colors.get(mode).ok_or(ImportError::Conversion)?;
  let table_fill = colors.get("background-code-block").cloned();
  let table_ink = table_fill
    .as_deref()
    .map(myoxus_domain::color::adaptive_foreground)
    .map(str::to_owned);
  let table_rule = colors.get("rule").cloned();
  let mut requested: std::collections::BTreeSet<_> = families.iter().cloned().collect();
  requested.extend(
    typography
      .values()
      .map(|style: &docx::ExportTypography| style.family.clone()),
  );
  let (assets, aliases) = export_font_assets(state, &pool, &requested).await?;
  for family in &mut families {
    if let Some(alias) = aliases.get(family) {
      *family = alias.clone();
    }
  }
  for style in typography.values_mut() {
    if let Some(alias) = aliases.get(&style.family) {
      style.family = alias.clone();
    }
  }
  Ok(docx::ExportFonts {
    assets,
    body: families[0].clone(),
    heading: families[1].clone(),
    mono: families[2].clone(),
    typography,
    table_fill,
    table_ink,
    table_rule,
    colors: myoxus_infrastructure::pdf_export::theme::document_color_values(colors, mode),
    visuals: state
      .preview_runtime
      .document_figure_context(state, workspace)
      .await
      .ok(),
  })
}

/// Resolve static full faces from the existing approved catalog. The encoder
/// subsequently drops families used only by unused style definitions.
async fn export_font_assets(
  state: &ApiState,
  pool: &sqlx::PgPool,
  requested: &std::collections::BTreeSet<String>,
) -> Result<(Vec<docx::FontToEmbed>, std::collections::BTreeMap<String, String>), ImportError> {
  let catalog = myoxus_infrastructure::branding::list_font_families(pool, true)
    .await
    .map_err(|_| ImportError::Conversion)?;
  let mut fonts = Vec::new();
  let mut aliases = std::collections::BTreeMap::new();
  let mut loaded = std::collections::BTreeMap::<String, Arc<Vec<u8>>>::new();
  let mut total = 0usize;
  for name in requested {
    let family = catalog
      .iter()
      .find(|f| (&f.display_name == name || &f.css_family == name) && f.license_status == "approved")
      .ok_or(ImportError::Conversion)?;
    for italic in [false, true] {
      for bold in [false, true] {
        let weight: i32 = if bold { 700 } else { 400 };
        let asset = family
          .assets
          .iter()
          .filter(|a| a.usage == "pdf" && matches!(a.format.as_str(), "ttf" | "otf") && (a.style != "normal") == italic)
          .min_by_key(|a| ((a.weight_default - weight).abs(), a.asset_key.as_str()));
        let Some(asset) = asset else {
          if !italic {
            return Err(ImportError::Conversion);
          }
          // A family without an italic face keeps Office's normal synthesis.
          continue;
        };
        let data = if let Some(bytes) = loaded.get(&asset.sha256) {
          bytes.clone()
        } else {
          let bytes = if family.source == "bundled" {
            // Catalog keys are filenames; never interpret one as a filesystem path.
            if asset.asset_key.contains(['/', '\\']) || asset.asset_key.contains("..") {
              return Err(ImportError::Conversion);
            }
            tokio::fs::read(super::fonts::bundled_fonts_dir().join(&asset.asset_key))
              .await
              .map_err(|_| ImportError::Conversion)?
          } else {
            state
              .pdf_blob_store()
              .ok_or(ImportError::Conversion)?
              .get_template_file(&asset.asset_key)
              .await
              .map_err(|_| ImportError::Conversion)?
          };
          total = total.checked_add(bytes.len()).ok_or(ImportError::TooLarge)?;
          if total as u64 > myoxus_workspace_import::WorkspaceImportLimits::default().max_document_bytes {
            return Err(ImportError::TooLarge);
          }
          if hex::encode(Sha256::digest(&bytes)) != asset.sha256 {
            return Err(ImportError::Conversion);
          }
          let bytes = Arc::new(bytes);
          loaded.insert(asset.sha256.clone(), bytes.clone());
          bytes
        };
        let metadata = myoxus_application::pdf_export::font_validator::validate_font_bytes(&data)
          .map_err(|_| ImportError::Conversion)?;
        // Do not advertise an upright-only decorative face as a supplied bold
        // face: omitting that entry lets the reader synthesize its normal bold.
        if bold && metadata.weight < 600 {
          continue;
        }
        // RFN-protected static derivatives carry a different legal family name.
        // Use their actual SFNT family in both Word's styles and its font table.
        if aliases
          .insert(name.clone(), metadata.family_name.clone())
          .is_some_and(|old| old != metadata.family_name)
        {
          return Err(ImportError::Conversion);
        }
        fonts.push(docx::FontToEmbed {
          name: metadata.family_name,
          bold,
          italic,
          data,
        });
      }
    }
  }
  Ok((fonts, aliases))
}

#[tracing::instrument(skip_all)]
pub async fn export_docx_handler(
  State(state): State<ApiState>,
  Path((workspace, guid)): Path<(String, String)>,
  headers: HeaderMap,
) -> Response {
  let Ok(workspace) = Uuid::parse_str(&workspace) else {
    return error(
      StatusCode::BAD_REQUEST,
      "invalid_workspace",
      "The workspace identifier is invalid.",
    );
  };
  let actor = match crate::require_workspace_read_user(&state, &headers, workspace).await {
    Ok(actor) => actor,
    Err(status) => return error(status, "access_denied", "Access to this workspace is denied."),
  };
  let key = match crate::handlers::rpc::parse_document_key_or_pseudo_not_found(&guid) {
    Ok(key) => key,
    Err(status) => return error(status, "invalid_document", "The document identifier is invalid."),
  };
  let authorized = match crate::document_access::authorize_workspace_document(
    &state,
    actor,
    workspace,
    DocSpaceKind::Workspace,
    &key,
    DocAction::Read,
  )
  .await
  {
    Ok(authorized) => authorized,
    Err(cause) => {
      return error(
        crate::document_access::status_from_auth_error(cause),
        "access_denied",
        "Access to this document is denied.",
      );
    }
  };
  let permits = EXPORT_PERMITS.get_or_init(|| Arc::new(Semaphore::new(2)));
  let Ok(permit) = permits.clone().try_acquire_owned() else {
    return error(
      StatusCode::TOO_MANY_REQUESTS,
      "export_busy",
      "Document conversion is busy. Try again shortly.",
    );
  };
  // The operation retains admission even when the HTTP waiter times out. In
  // particular dropping a spawn_blocking handle does not cancel its CPU work.
  let task = tokio::spawn(async move {
    let _permit = permit;
    let document = state
      .doc()
      .get_doc_metadata(authorized.doc_id)
      .await?
      .ok_or_else(|| ImportError::Storage(myoxus_application::auth::AuthError::NotFound("document".into())))?;
    if document
      .public_mode
      .as_deref()
      .is_some_and(|mode| mode.eq_ignore_ascii_case("edgeless"))
    {
      return Err(ImportError::Invalid);
    }
    let fonts = export_fonts(&state, workspace).await?;
    let captured = docx::capture_export_source(state.doc(), workspace, &document).await?;
    let can_read_blobs = match state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: actor,
          workspace_id: workspace,
        },
        WorkspaceAction::BlobsRead,
      )
      .await
    {
      Ok(()) => true,
      Err(myoxus_application::auth::AuthError::ActionForbidden) => false,
      Err(cause) => return Err(ImportError::Storage(cause)),
    };
    let mut references = export_reference_presentation(&state, actor, workspace, &captured).await?;
    resolve_media_fallbacks(
      &state,
      workspace,
      &document.external_id,
      &captured,
      can_read_blobs,
      &mut references,
    )
    .await?;
    let source = docx::resolve_export_assets(captured, state.blob(), can_read_blobs, references).await?;
    tokio::task::spawn_blocking(move || docx::encode_export(source, fonts))
      .await
      .map_err(|_| ImportError::Conversion)?
  });
  match tokio::time::timeout(std::time::Duration::from_secs(120), task).await {
    Ok(Ok(Ok(output))) => {
      let warnings = match serde_json::to_string(&output.warnings) {
        Ok(warnings) => warnings,
        Err(_) => {
          return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "conversion_failed",
            "The document could not be converted.",
          );
        }
      };
      (
        [
          (
            axum::http::header::CONTENT_TYPE,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
          ),
          (
            axum::http::header::CONTENT_DISPOSITION,
            docx_content_disposition(&output.title),
          ),
          (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
          (
            axum::http::HeaderName::from_static("x-myoxus-conversion-warnings"),
            warnings,
          ),
        ],
        output.bytes,
      )
        .into_response()
    }
    Ok(Ok(Err(ImportError::Storage(cause)))) => error(
      crate::document_access::status_from_auth_error(cause),
      "export_failed",
      "The document could not be exported.",
    ),
    Ok(Ok(Err(ImportError::TooLarge))) => error(
      StatusCode::PAYLOAD_TOO_LARGE,
      "docx_too_large",
      "The document exceeds the conversion limits.",
    ),
    Ok(Ok(Err(ImportError::Empty))) => error(
      StatusCode::UNPROCESSABLE_ENTITY,
      "empty_docx",
      "No usable content was found in this document.",
    ),
    Ok(Ok(Err(ImportError::Invalid))) => error(
      StatusCode::UNPROCESSABLE_ENTITY,
      "unsupported_mode",
      "Word export supports Page documents only.",
    ),
    Err(_) => error(
      StatusCode::GATEWAY_TIMEOUT,
      "export_timeout",
      "Document conversion timed out. You can retry the export.",
    ),
    _ => error(
      StatusCode::INTERNAL_SERVER_ERROR,
      "conversion_failed",
      "The document could not be converted.",
    ),
  }
}

#[tracing::instrument(skip_all)]
async fn export_reference_presentation(
  state: &ApiState,
  actor: Uuid,
  workspace: Uuid,
  captured: &docx::CapturedDocx,
) -> Result<docx::ExportReferencePresentation, ImportError> {
  let mut presentation = docx::ExportReferencePresentation::default();
  let mut documents = std::collections::BTreeMap::new();
  let mut mentions = std::collections::BTreeSet::new();
  for span in captured
    .ir
    .native_text
    .values()
    .flat_map(|block| &block.fields)
    .flat_map(|field| &field.spans)
  {
    // Annotation text is literal; its stale atom attributes never grant access.
    if span.annotation_id.is_some() {
      continue;
    }
    if let Some(reference) = &span.reference {
      let scope = match span.reference_workspace.as_ref() {
        None => Some(workspace),
        Some(value) => value.as_str().and_then(|value| Uuid::parse_str(value).ok()),
      };
      documents
        .entry(docx::inline_reference_key(reference, span.reference_workspace.as_ref()))
        .or_insert((scope, reference.page_id.clone(), reference.params.clone()));
    }
    if let Some(mention) = &span.mention {
      mentions.insert(mention.member.clone());
    }
  }
  let blocks = captured
    .native_snapshot
    .as_ref()
    .map(|snapshot| docx::block_reference_inventory(snapshot, workspace))
    .unwrap_or_default();
  if documents.len() + blocks.len() + mentions.len() > 2048 {
    return Err(ImportError::TooLarge);
  }
  for (identity, (scope, key, params)) in documents {
    let Some(workspace) = scope else {
      continue;
    };
    if let Some(target) =
      resolve_export_target(state, actor, docx::ReferenceTarget::Document { workspace, key, params }).await?
    {
      presentation.documents.insert(identity, target);
    }
  }
  for (id, source) in blocks {
    let target = match source.target {
      Some(target) => resolve_export_target(state, actor, target).await?,
      None => None,
    };
    if let Some(mut target) = target {
      // Authored aliases may be used only after the actual target is admitted.
      if let Some(alias) = source.alias {
        target.label = alias;
      }
      presentation.blocks.insert(id, target);
    } else {
      presentation.unavailable_blocks.insert(id);
    }
  }
  if !mentions.is_empty() {
    match state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: actor,
          workspace_id: workspace,
        },
        WorkspaceAction::UsersRead,
      )
      .await
    {
      Ok(()) => {
        for id in mentions {
          let Ok(user) = Uuid::parse_str(&id) else {
            continue;
          };
          let Some(member) = state.workspace().get_member(workspace, user).await? else {
            continue;
          };
          if member.status == myoxus_domain::entities::MembershipStatus::Accepted && !member.user.disabled {
            presentation.mentions.insert(id, member.user.name);
          }
        }
      }
      Err(myoxus_application::auth::AuthError::ActionForbidden) => {}
      Err(cause) => return Err(ImportError::Storage(cause)),
    }
  }
  Ok(presentation)
}

#[tracing::instrument(skip_all)]
async fn resolve_media_fallbacks(
  state: &ApiState,
  workspace: Uuid,
  source_key: &str,
  captured: &docx::CapturedDocx,
  can_read_blobs: bool,
  presentation: &mut docx::ExportReferencePresentation,
) -> Result<(), ImportError> {
  use myoxus_application::{
    markdown::{AuthorizedMarkdownDocument, MarkdownReferenceLookup},
    ports::blob::{BlobKey, BlobStatus},
  };
  let Some(snapshot) = &captured.native_snapshot else {
    return Ok(());
  };
  let inventory = docx::block_fallback_inventory(snapshot, &captured.ir);
  if inventory.len() > 2048 {
    return Err(ImportError::TooLarge);
  }
  let source = MarkdownReferenceLookup::new(
    &format!(
      "{}/workspace/{workspace}",
      state.config.server.origin.trim_end_matches('/')
    ),
    [AuthorizedMarkdownDocument {
      external_id: source_key.to_string(),
      title: captured.ir.document.title.clone(),
    }],
  )
  .map_err(|_| ImportError::Conversion)?;
  for (id, fallback) in inventory {
    let value = match fallback {
      docx::NativeFallback::File { key, name } => {
        let metadata = if can_read_blobs {
          match key.filter(|key| BlobKey::parse(key).is_ok()) {
            Some(key) => state
              .blob()
              .get_blob_metadata(workspace, &key)
              .await?
              .filter(|metadata| metadata.status == BlobStatus::Completed && metadata.deleted_at.is_none()),
            None => None,
          }
        } else {
          None
        };
        if let Some(metadata) = metadata {
          let kind = if metadata.mime.starts_with("audio/") {
            "Audio"
          } else if metadata.mime.starts_with("video/") {
            "Video"
          } else {
            "Attachment"
          };
          let label = name
            .filter(|name| !name.trim().is_empty())
            .map_or_else(|| kind.to_string(), |name| format!("{kind}: {name}"));
          let target = source.resolve_export_reference(&yjs::MarkdownDocumentReference {
            page_id: source_key.to_string(),
            title: None,
            description: None,
            params: Some(serde_json::json!({"blockIds":[id]})),
          });
          docx::ReadableFallback {
            label,
            url: target.map(|target| target.url),
            explanation: Some("Binary/player is not embedded in Word."),
            code: "media_reference_normalized",
          }
        } else {
          // Source Page access does not grant access to an individual blob.
          // Never reveal a cached name or its raw key after that check fails.
          docx::ReadableFallback {
            label: "[Attachment unavailable]".into(),
            url: None,
            explanation: Some("Binary/player is not embedded in Word."),
            code: "media_reference_omitted",
          }
        }
      }
      docx::NativeFallback::External { url, label } => {
        let url = url.as_deref().and_then(docx::safe_external_reference);
        let readable = url.is_some();
        docx::ReadableFallback {
          label: if readable {
            label.unwrap_or_else(|| "External content".into())
          } else {
            "[External content unavailable]".into()
          },
          url,
          explanation: Some("Widget/player is not embedded in Word."),
          code: if readable {
            "external_widget_normalized"
          } else {
            "external_widget_omitted"
          },
        }
      }
      docx::NativeFallback::Text { label } => {
        let readable = label.is_some();
        docx::ReadableFallback {
          label: label
            .map(|label| format!("[Unsupported block] {label}"))
            .unwrap_or_default(),
          url: None,
          explanation: None,
          code: if readable {
            "unsupported_block_normalized"
          } else {
            "unsupported_block_omitted"
          },
        }
      }
    };
    presentation.fallbacks.insert(id, value);
  }
  Ok(())
}

/// Use the same canonical document-key/ACL and Database read owners as normal
/// navigation. Individual denied/missing targets are safe fallbacks, never a
/// reason to reveal their cached native title or recursively read their body.
#[tracing::instrument(skip_all)]
async fn resolve_export_target(
  state: &ApiState,
  actor: Uuid,
  target: docx::ReferenceTarget,
) -> Result<Option<docx::ReadableReference>, ImportError> {
  use myoxus_application::{
    auth::AuthError,
    database::{ERR_FORBIDDEN, ERR_NOT_FOUND},
    markdown::{AuthorizedMarkdownDocument, MarkdownReferenceLookup},
  };
  match target {
    docx::ReferenceTarget::Document { workspace, key, params } => {
      let key = match crate::handlers::rpc::parse_document_key_or_pseudo_not_found(&key) {
        Ok(key) => key,
        Err(_) => return Ok(None),
      };
      let authorized = match crate::document_access::authorize_workspace_document(
        state,
        actor,
        workspace,
        DocSpaceKind::Workspace,
        &key,
        DocAction::Read,
      )
      .await
      {
        Ok(target) => target,
        Err(AuthError::ActionForbidden | AuthError::NotFound(_)) => return Ok(None),
        Err(cause) => return Err(ImportError::Storage(cause)),
      };
      let Some(document) = state
        .doc()
        .get_doc_metadata(authorized.doc_id)
        .await?
        .filter(|doc| doc.workspace_id == Some(workspace) && !doc.blocked)
      else {
        return Ok(None);
      };
      let lookup = MarkdownReferenceLookup::new(
        &format!(
          "{}/workspace/{workspace}",
          state.config.server.origin.trim_end_matches('/')
        ),
        [AuthorizedMarkdownDocument {
          external_id: document.external_id.clone(),
          title: document.title,
        }],
      )
      .map_err(|_| ImportError::Conversion)?;
      let reference = yjs::MarkdownDocumentReference {
        page_id: document.external_id,
        title: None,
        description: None,
        params,
      };
      Ok(
        lookup
          .resolve_export_reference(&reference)
          .map(|target| docx::ReadableReference {
            label: target.title,
            url: target.url,
          }),
      )
    }
    docx::ReferenceTarget::Database { workspace, id, row } => {
      let Some(services) = state.database_services() else {
        return Ok(None);
      };
      let record = match services.definition.get_database(actor, id).await {
        Ok(record) if record.database.workspace_id == workspace && record.database.deleted_at.is_none() => record,
        Ok(_) => return Ok(None),
        Err(cause) if matches!(cause.code, ERR_FORBIDDEN | ERR_NOT_FOUND) => return Ok(None),
        Err(_) => return Err(ImportError::Conversion),
      };
      if let Some(row) = row {
        match services.views.get_row_for_read(actor, id, row, false).await {
          Ok(Some(_)) => {}
          Ok(None) => return Ok(None),
          Err(cause) if matches!(cause.code, ERR_FORBIDDEN | ERR_NOT_FOUND) => return Ok(None),
          Err(_) => return Err(ImportError::Conversion),
        }
      }
      let mut url = reqwest::Url::parse(&format!(
        "{}/workspace/{workspace}/databases/{id}",
        state.config.server.origin.trim_end_matches('/')
      ))
      .map_err(|_| ImportError::Conversion)?;
      if let Some(row) = row {
        url.query_pairs_mut().append_pair("rowId", &row.to_string());
      }
      Ok(Some(docx::ReadableReference {
        label: record.database.title,
        url: url.into(),
      }))
    }
  }
}

fn docx_content_disposition(title: &str) -> String {
  let stem = title.trim();
  let stem = if stem.to_ascii_lowercase().ends_with(".docx") {
    &stem[..stem.len() - 5]
  } else {
    stem
  };
  let stem: String = stem
    .chars()
    .take(180)
    .map(|c| {
      if c.is_control() || matches!(c, '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>') {
        '-'
      } else {
        c
      }
    })
    .collect();
  let stem = stem.trim_matches([' ', '.']);
  let stem = if stem.is_empty() { "export" } else { stem };
  let ascii: String = stem.chars().map(|c| if c.is_ascii() { c } else { '-' }).collect();
  format!(
    "attachment; filename=\"{ascii}.docx\"; filename*=UTF-8''{}",
    urlencoding::encode(&format!("{stem}.docx"))
  )
}

fn error(status: StatusCode, code: &'static str, message: &'static str) -> Response {
  (status, Json(DocxErrorBody { code, message })).into_response()
}

fn import_error(error_value: ImportError) -> Response {
  match error_value {
    ImportError::Invalid => error(
      StatusCode::UNPROCESSABLE_ENTITY,
      "unreadable_docx",
      "This is not a readable Word document.",
    ),
    ImportError::TooLarge => error(
      StatusCode::PAYLOAD_TOO_LARGE,
      "docx_too_large",
      "The Word document exceeds the import limits.",
    ),
    ImportError::Empty => error(
      StatusCode::UNPROCESSABLE_ENTITY,
      "empty_docx",
      "No usable content was found in this Word document.",
    ),
    ImportError::Conversion => error(
      StatusCode::INTERNAL_SERVER_ERROR,
      "conversion_failed",
      "The Word document could not be converted.",
    ),
    ImportError::Storage(err) => error(
      crate::document_access::status_from_auth_error(err),
      "import_failed",
      "The document could not be created.",
    ),
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxImportResponse {
  id: String,
  title: String,
  warnings: Vec<docx::ConversionWarning>,
  best_effort: bool,
}

#[tracing::instrument(skip_all)]
pub async fn import_docx_handler(
  State(state): State<ApiState>,
  Path(workspace): Path<String>,
  headers: HeaderMap,
  multipart: Result<Multipart, MultipartRejection>,
) -> Response {
  let Ok(workspace) = Uuid::parse_str(&workspace) else {
    return error(
      StatusCode::BAD_REQUEST,
      "invalid_workspace",
      "The workspace identifier is invalid.",
    );
  };
  let actor = match crate::require_workspace_read_user(&state, &headers, workspace).await {
    Ok(actor) => actor,
    Err(status) => return error(status, "access_denied", "Access to this workspace is denied."),
  };
  let mut multipart = match multipart {
    Ok(multipart) => multipart,
    Err(rejection) => return error(rejection.status(), "invalid_upload", "Select one .docx Word document."),
  };
  if let Err(cause) = state
    .permission_service()
    .assert(
      &WorkspaceResource {
        user_id: actor,
        workspace_id: workspace,
      },
      WorkspaceAction::CreateDoc,
    )
    .await
  {
    let status = crate::document_access::status_from_auth_error(cause);
    return if status == StatusCode::FORBIDDEN {
      error(
        status,
        "create_denied",
        "You cannot create documents in this workspace.",
      )
    } else {
      error(status, "import_failed", "Workspace permissions could not be checked.")
    };
  }

  let permits = IMPORT_PERMITS.get_or_init(|| Arc::new(Semaphore::new(2)));
  let Ok(permit) = permits.clone().try_acquire_owned() else {
    return error(
      StatusCode::TOO_MANY_REQUESTS,
      "import_busy",
      "Document conversion is busy. Try again shortly.",
    );
  };
  let mut file = None;
  loop {
    let field = match multipart.next_field().await {
      Ok(field) => field,
      Err(_) => {
        return error(
          StatusCode::BAD_REQUEST,
          "invalid_upload",
          "The uploaded document could not be read.",
        );
      }
    };
    let Some(field) = field else {
      break;
    };
    if file.is_some() || field.name() != Some("file") {
      return error(
        StatusCode::BAD_REQUEST,
        "invalid_upload",
        "Select exactly one Word document.",
      );
    }
    let filename = field.file_name().unwrap_or("").to_string();
    if !filename.to_ascii_lowercase().ends_with(".docx") {
      return error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_format",
        "Select a .docx Word document.",
      );
    }
    let bytes = match field.bytes().await {
      Ok(bytes) if bytes.len() <= MAX_UPLOAD => bytes,
      Ok(_) => {
        return error(
          StatusCode::PAYLOAD_TOO_LARGE,
          "docx_too_large",
          "The Word document exceeds the import limits.",
        );
      }
      Err(_) => {
        return error(
          StatusCode::BAD_REQUEST,
          "invalid_upload",
          "The uploaded document could not be read.",
        );
      }
    };
    file = Some((filename, bytes));
  }
  let Some((filename, bytes)) = file else {
    return error(
      StatusCode::BAD_REQUEST,
      "invalid_upload",
      "Select a Word document to import.",
    );
  };

  // The detached operation owns admission until blocking conversion and page
  // publication actually finish. Timing out or closing the HTTP waiter cannot
  // make a second conversion run in its place while the first is still active.
  let task = tokio::spawn(async move {
    let _permit = permit;
    let parsed = tokio::task::spawn_blocking(move || docx::prepare_docx(&bytes, &filename))
      .await
      .map_err(|_| ImportError::Conversion)??;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: actor,
          workspace_id: workspace,
        },
        WorkspaceAction::CreateDoc,
      )
      .await
      .map_err(ImportError::Storage)?;
    let result = docx::publish_docx(parsed, workspace, actor, state.blob(), state.doc()).await?;
    for (key, delta) in [
      (result.doc.external_id.clone(), &result.sync_updates.document),
      (workspace.to_string(), &result.sync_updates.workspace_root),
    ] {
      if crate::websocket::publish_persisted_workspace_doc_update(&state, workspace, &key, delta, actor)
        .await
        .is_err()
      {
        // The page is committed even if live fan-out is unavailable. Reconnect
        // reads the same persisted deltas; never report a rolled-back creation.
        tracing::warn!(%workspace, "DOCX page committed but live publication was delayed");
      }
    }
    Ok::<_, ImportError>(result)
  });
  match tokio::time::timeout(std::time::Duration::from_secs(120), task).await {
    Ok(Ok(Ok(result))) => (
      StatusCode::CREATED,
      Json(DocxImportResponse {
        id: result.doc.external_id,
        title: result.doc.title,
        warnings: result.warnings,
        best_effort: true,
      }),
    )
      .into_response(),
    Ok(Ok(Err(error_value))) => import_error(error_value),
    Ok(Err(_)) => error(
      StatusCode::INTERNAL_SERVER_ERROR,
      "import_failed",
      "The Word document could not be created.",
    ),
    Err(_) => error(
      StatusCode::GATEWAY_TIMEOUT,
      "import_outcome_unknown",
      "The import is still finishing. Check your workspace documents before trying again.",
    ),
  }
}
