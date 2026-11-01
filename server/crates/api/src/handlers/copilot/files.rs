// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authenticated answer-export adapter; no provider or tool execution.
use crate::{
  graphql::auth::{assert_copilot_session_access, types::CopilotGeneratedFileType},
  state::ApiState,
};
use axum::{
  extract::{Path, State},
  http::{HeaderMap, StatusCode, header},
  response::IntoResponse,
};
use base64::Engine;
use myoxus_application::{
  auth::{AuthError, AuthResult},
  copilot::files::*,
  doc::content_projection::{
    DocumentContentProjection, DocumentContentProjectionService, DocumentProjectionRequest, DocumentRepresentation,
  },
  permission::{AccessController, WorkspaceResource},
};
use myoxus_domain::{
  entities::{CopilotAttachmentRef, CopilotFileFormat, CopilotSession},
  permission::WorkspaceAction,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

pub(crate) fn file_service(state: Arc<ApiState>, user_id: Uuid) -> CopilotFileService {
  CopilotFileService {
    copilot: state.copilot().as_ref().clone(),
    storage: state.storage().clone(),
    max_bytes: state.config.mcp.document_export_max_bytes,
    renderer: Arc::new(Renderer { state, user_id }),
  }
}
struct Renderer {
  state: Arc<ApiState>,
  user_id: Uuid,
}
fn unavailable(message: &str) -> AuthError {
  AuthError::InvalidInput(message.into())
}

#[async_trait::async_trait]
impl CopilotFileRenderer for Renderer {
  async fn authorize(&self, session: &CopilotSession) -> AuthResult<()> {
    // Reload the binding, not only the request-start copy. The SQL publication
    // compares that binding again under its existing session/message lock.
    let live = self.state.copilot().get_session(session.id).await?;
    if live.workspace_id != session.workspace_id || live.doc_id != session.doc_id || live.metadata != session.metadata {
      return Err(AuthError::ActionForbidden);
    }
    assert_copilot_session_access(&self.state, self.user_id, &live, "copilot.export")
      .await
      .map_err(|_| AuthError::ActionForbidden)?;
    self
      .state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: self.user_id,
          workspace_id: live.workspace_id.ok_or(AuthError::ActionForbidden)?,
        },
        WorkspaceAction::BlobsRead,
      )
      .await
  }
  async fn capture(
    &self,
    source: &CopilotAnswerSnapshot,
    workspace_id: Uuid,
    format: CopilotFileFormat,
  ) -> AuthResult<CopilotFileRenderContext> {
    let limits = crate::pdf_export_adapter::effective_pdf_limits(&self.state)
      .await
      .map_err(|_| unavailable("Export limits unavailable"))?;
    // Count emitted native records, not inline Markdown tags. The PDF IR also
    // enforces its precise input budget when it builds the render source.
    let count = yjs::extract_text_from_yjs(&source.yjs)
      .map_err(|_| unavailable("Export source cannot be read"))?
      .blocks_visited as usize;
    if count > limits.max_input_blocks {
      return Err(unavailable("Answer exceeds export block limits"));
    }
    if format == CopilotFileFormat::Pdf {
      let service = crate::pdf_export_adapter::create_get_service(self.state.clone());
      return service
        .prepare_snapshot_render(workspace_id, source.message.id, source.locale.clone())
        .await
        .map(CopilotFileRenderContext::Pdf)
        .map_err(|e| unavailable(&e.message));
    }
    let pool = self
      .state
      .metrics_pool()
      .ok_or_else(|| unavailable("Theme storage unavailable"))?;
    let profile = myoxus_infrastructure::branding::load_effective_theme_profile(&pool, Some(workspace_id))
      .await
      .map_err(|_| unavailable("Theme unavailable"))?;
    let mut fonts = myoxus_infrastructure::branding::list_font_families(&pool, true)
      .await
      .map_err(|_| unavailable("Font catalog unavailable"))?;
    fonts.retain(|f| {
      profile
        .theme
        .typography_styles
        .iter()
        .any(|style| style.font_family_slug == f.slug)
    });
    let mut urls = std::collections::BTreeMap::new();
    let mut bytes_total = 0usize;
    for font in &fonts {
      let assets = font
        .assets
        .iter()
        .filter(|a| a.usage == "web" && a.format == "woff2")
        .collect::<Vec<_>>();
      if assets.is_empty() {
        return Err(unavailable("An effective theme font has no portable WOFF2 asset"));
      }
      for asset in assets {
        if asset.asset_key.contains(['/', '\\']) || asset.asset_key.contains("..") {
          return Err(unavailable("Invalid font asset"));
        }
        let path = crate::handlers::fonts::bundled_fonts_dir().join(&asset.asset_key);
        let size = tokio::fs::metadata(&path)
          .await
          .map_err(|_| unavailable("A theme font is unavailable"))?
          .len();
        if size > self.state.config.mcp.document_export_max_bytes as u64 {
          return Err(unavailable("Theme font exceeds export limits"));
        }
        let bytes = tokio::fs::read(path)
          .await
          .map_err(|_| unavailable("A theme font is unavailable"))?;
        bytes_total = bytes_total.saturating_add(bytes.len());
        if bytes_total > self.state.config.mcp.document_export_max_bytes
          || !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&asset.sha256)
        {
          return Err(unavailable("Theme font identity or size is invalid"));
        }
        urls.insert(
          asset.asset_key.clone(),
          format!(
            "data:font/woff2;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
          ),
        );
      }
    }
    let css = myoxus_infrastructure::branding::build_runtime_theme_css_with_font_urls(&profile, &fonts, &|asset| {
      urls[&asset.asset_key].clone()
    });
    let catalog = self
      .state
      .html_renderer()
      .map_err(|_| unavailable("HTML catalog unavailable"))?;
    let fingerprint = hex::encode(Sha256::digest(format!("{}:{css}", catalog.content_hash())));
    Ok(CopilotFileRenderContext::Html { css, fingerprint })
  }
  async fn render(&self, source: &CopilotAnswerSnapshot, context: CopilotFileRenderContext) -> AuthResult<Vec<u8>> {
    match context {
      CopilotFileRenderContext::Pdf(request) => {
        let service = crate::pdf_export_adapter::create_get_service(self.state.clone());
        let result = service
          .backend
          .render_snapshot(request, source.yjs.clone(), source.message.created_at)
          .await
          .map_err(|e| unavailable(&e.message))?;
        if !result.unmapped_font_families.is_empty()
          || result.renderer_diagnostics.as_array().is_none_or(|a| !a.is_empty())
        {
          return Err(unavailable("The PDF renderer reported incomplete content"));
        }
        Ok(result.bytes)
      }
      CopilotFileRenderContext::Html { css, .. } => {
        let session = self.state.copilot().get_session(source.message.session_id).await?;
        let projection = DocumentContentProjectionService::new(self.state.doc().load.clone(), Vec::<u8>::new())
          .with_html_catalog(self.state.html_catalog())
          .with_max_output_bytes(self.state.config.mcp.document_export_max_bytes)
          .project_portable_html(
            DocumentProjectionRequest {
              workspace_id: session.workspace_id.ok_or(AuthError::ActionForbidden)?,
              doc_id: source.message.id,
              fallback_title: source.title.clone(),
              metadata_badges: vec![],
              representation: DocumentRepresentation::Html,
              cursor: None,
              limit: None,
              theme_css_url: String::new(),
              selector: None,
              neighbor_context: 0,
            },
            &source.yjs,
            myoxus_public_render::PrivateHtmlRenderOptions {
              theme_css_url: String::new(),
              locale: source.locale.clone(),
              portable_css: Some(css),
            },
          )
          .map_err(|_| unavailable("The private HTML catalog cannot produce a portable file"))?;
        let DocumentContentProjection::Export(output) = projection else {
          return Err(unavailable("HTML projection unavailable"));
        };
        if !output.complete || output.lossy || !output.diagnostics.is_empty() || !output.assets.is_empty() {
          return Err(unavailable("The HTML renderer reported unsupported content"));
        }
        validate_portable_html(&output.data)?;
        Ok(output.data.into_bytes())
      }
    }
  }
}

pub(crate) fn descriptor(file: &CopilotAttachmentRef) -> Option<CopilotGeneratedFileType> {
  let metadata = file.generated_file()?;
  Some(CopilotGeneratedFileType {
    id: file.id.to_string().into(),
    file_name: file.file_name.clone()?,
    mime_type: metadata.format.media_type().into(),
    size_bytes: file.size_bytes?,
    format: metadata.format.extension().into(),
    download_url: format!("/api/copilot/messages/{}/files/{}", file.message_id, file.id),
  })
}

#[tracing::instrument(skip_all)]
pub(crate) async fn download(
  State(state): State<ApiState>,
  Path((message_id, file_id)): Path<(Uuid, Uuid)>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let user = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?
    .user;
  let message = state
    .copilot()
    .get_message(message_id)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
  let session = state
    .copilot()
    .get_session(message.session_id)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
  Renderer {
    state: Arc::new(state.clone()),
    user_id: user.id,
  }
  .authorize(&session)
  .await
  .map_err(|_| StatusCode::FORBIDDEN)?;
  let file = message
    .attachment_refs
    .iter()
    .find(|a| a.id == file_id && a.generated_file().is_some())
    .ok_or(StatusCode::NOT_FOUND)?;
  let metadata = file.generated_file().ok_or(StatusCode::NOT_FOUND)?;
  if !file.blob_key.starts_with(&format!(
    "copilot-output/{}/{}/",
    session.workspace_id.ok_or(StatusCode::FORBIDDEN)?,
    user.id
  )) {
    return Err(StatusCode::NOT_FOUND);
  }
  let blob = state
    .storage()
    .read_blob_bounded(&file.blob_key, state.config.mcp.document_export_max_bytes as u64)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
  if file.size_bytes != Some(blob.data.len() as i64) {
    return Err(StatusCode::INTERNAL_SERVER_ERROR);
  }
  let filename = file.file_name.as_deref().unwrap_or("answer");
  let ascii = filename
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_') {
        c
      } else {
        '_'
      }
    })
    .collect::<String>();
  let mut response = blob.data.into_response();
  crate::handlers::blob::secure_download_headers(response.headers_mut(), metadata.format.media_type(), &ascii)?;
  response.headers_mut().insert(
    header::CONTENT_DISPOSITION,
    format!(
      "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
      urlencoding::encode(filename)
    )
    .parse()
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response.headers_mut().insert(
    header::CONTENT_TYPE,
    metadata
      .format
      .media_type()
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response.headers_mut().insert(
    header::CACHE_CONTROL,
    "private, no-store".parse().expect("static header"),
  );
  Ok(response)
}
