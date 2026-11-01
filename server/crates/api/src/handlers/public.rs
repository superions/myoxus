//! Anonymous public publishing routes.
//!
//! Public reads are not workspace reads. These handlers use the public ACL
//! service and return 404 for all anonymous denials.

use axum::{
  extract::{Path, Query, State},
  http::{HeaderMap, StatusCode, header},
  response::{IntoResponse, Redirect, Response},
};
use myoxus_application::auth::AuthError;
use myoxus_application::doc::DocSpaceKind;
use myoxus_application::document_metadata::DocumentMetadataProjectionMode;
use myoxus_application::public::{
  DEFAULT_PUBLIC_THEME_VERSION, PUBLIC_RENDERER_VERSION, PUBLIC_REVOCABLE_CACHE_CONTROL, PublicAllow,
  PublicAssetManifestEntry, PublicService, document_metadata_badges, source_hash,
};
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::repositories::PageRequest;
use myoxus_infrastructure::public::{PgPublicRepository, artifact_for_html, asset_manifest_entry};
use myoxus_public_render::{
  HtmlRenderOptions, PublicBreadcrumb, PublicDocIr, PublicSiteShellOptions, WorkspaceIndex, WorkspaceIndexFolder,
  WorkspaceIndexItem, apply_public_asset_url, document_from_yjs, public_document_path, public_folder_path,
  render_document_html, render_workspace_index_html, resolve_asset_candidates,
};
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::state::ApiState;

fn public_service(state: &ApiState) -> Result<PublicService<PgPublicRepository>, StatusCode> {
  let pool = state.metrics_pool().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
  Ok(PublicService::new(PgPublicRepository::new(pool)))
}

fn parse_uuid(value: &str) -> Result<Uuid, StatusCode> {
  Uuid::parse_str(value).map_err(|_| StatusCode::NOT_FOUND)
}

async fn resolve_public_route_doc_id(
  state: &ApiState,
  workspace_id: Uuid,
  route_doc_id: &str,
) -> Result<Uuid, StatusCode> {
  let document_key = DocumentKey::parse(route_doc_id).map_err(|_| StatusCode::NOT_FOUND)?;
  let doc_id = state
    .doc()
    .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &document_key)
    .await
    .map_err(|err| {
      warn!(%workspace_id, route_doc_id, error = %err, "public route doc id resolution failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .ok_or(StatusCode::NOT_FOUND)?;
  let metadata = state
    .doc()
    .get_metadata(doc_id)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::NOT_FOUND)?;
  if metadata.deleted_at.is_some() {
    return Err(StatusCode::NOT_FOUND);
  }
  Ok(doc_id)
}

fn canonical_url(state: &ApiState, path: &str) -> String {
  format!("{}{}", state.config.server.origin.trim_end_matches('/'), path)
}

fn public_theme_css_url(workspace_id: Uuid) -> String {
  format!("/api/branding/theme.css?workspaceId={workspace_id}")
}

fn html_options(state: &ApiState, workspace_id: Uuid, path: &str, noindex: bool) -> HtmlRenderOptions {
  let public = &state.config.public_publishing;
  HtmlRenderOptions {
    canonical_url: canonical_url(state, path),
    theme_css_url: public_theme_css_url(workspace_id),
    favicon_url: "/favicon.ico".to_string(),
    noindex,
    locale: state.config.i18n.default_locale.clone(),
    snapshot_relative_links: false,
    site_shell: PublicSiteShellOptions {
      breadcrumbs_enabled: public.site_shell.breadcrumbs_enabled,
      toc_enabled: public.site_shell.toc_enabled,
      max_toc_depth: public.site_shell.max_toc_depth,
      previous_next_enabled: public.site_shell.previous_next_enabled,
      code_copy_enabled: public.site_shell.code_copy_enabled,
      syntax_highlighting_enabled: public.site_shell.syntax_highlighting_enabled,
      search_enabled: false,
      asset_base_url: None,
      search_bundle_url: None,
      social_card_url: None,
      breadcrumbs: Vec::new(),
      previous: None,
      next: None,
      footer_note: None,
    },
  }
}

fn html_response(_state: &ApiState, html: String, noindex: bool) -> Response {
  let robots = if noindex { "noindex,nofollow" } else { "index,follow" };
  (
    StatusCode::OK,
    [
      (header::CONTENT_TYPE, "text/html; charset=utf-8"),
      (header::CACHE_CONTROL, PUBLIC_REVOCABLE_CACHE_CONTROL),
      (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
      (header::HeaderName::from_static("x-robots-tag"), robots),
    ],
    html,
  )
    .into_response()
}

#[derive(Default, Deserialize)]
pub(crate) struct PublicWorkspaceQuery {
  folder: Option<String>,
  first: Option<i64>,
  offset: Option<i64>,
}

#[instrument(skip_all, fields(workspace_id = %workspace_id, route = "/public/{workspace_id}"))]
pub(crate) async fn public_workspace_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<String>,
  Query(query): Query<PublicWorkspaceQuery>,
) -> Result<Response, StatusCode> {
  if !state.config.public_publishing.enabled || !state.config.public_publishing.dynamic_routes_enabled {
    return Err(StatusCode::NOT_FOUND);
  }
  let workspace_id = parse_uuid(&workspace_id)?;
  let service = public_service(&state)?;
  let overview = state
    .workspace_overview_service()
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
  let read = overview
    .read_public(
      &service,
      workspace_id,
      query.folder.as_deref(),
      PageRequest {
        limit: query.first.unwrap_or(50),
        offset: query.offset.unwrap_or(0),
      },
    )
    .await
    .map_err(|err| match err {
      AuthError::NotFound(_) | AuthError::ActionForbidden => StatusCode::NOT_FOUND,
      _ => {
        warn!(%workspace_id, error = %err, "public overview read failed");
        StatusCode::INTERNAL_SERVER_ERROR
      }
    })?;
  let mut introduction = None;
  let mut assets = Vec::new();
  if let Some(document) = &read.page.introduction {
    match load_public_document(&state, &service, workspace_id, document.doc_id).await {
      Ok(loaded) => {
        introduction = Some(loaded.ir);
        assets = loaded.assets;
      }
      // The binding does not override the document's current publication state.
      Err(StatusCode::NOT_FOUND) => {
        if read.page.folder.is_some() && read.page.children.is_empty() && read.page.documents.is_empty() {
          return Err(StatusCode::NOT_FOUND);
        }
      }
      Err(status) => return Err(status),
    }
  }
  let allow = service
    .decide_workspace(workspace_id)
    .await
    .map_err(|err| {
      warn!(%workspace_id, error = %err, "public workspace ACL failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .allowed()
    .ok_or(StatusCode::NOT_FOUND)?;
  let path = read.page.folder.as_ref().map_or_else(
    || format!("/public/{workspace_id}"),
    |folder| public_folder_path(workspace_id, &folder.id),
  );
  let page_link = |offset: i64| {
    format!(
      "{path}{}first={}&offset={offset}",
      if path.contains('?') { '&' } else { '?' },
      read.register_page.limit
    )
  };
  let index = WorkspaceIndex {
    document_count: read.document_count as usize,
    previous_page: (read.register_page.offset > 0)
      .then(|| page_link((read.register_page.offset - read.register_page.limit).max(0))),
    next_page: (read.register_page.offset.saturating_add(read.register_page.limit) < read.document_count)
      .then(|| page_link(read.register_page.offset + read.register_page.limit)),
    register_columns: myoxus_application::workspace_overview::public_register_columns(&read.page),
    workspace_id,
    title: allow.title.clone().unwrap_or_else(|| "Public workspace".to_string()),
    description: if read.page.folder.is_none() {
      allow.workspace_description
    } else {
      String::new()
    },
    folder_title: read.page.folder.as_ref().map(|folder| folder.name.clone()),
    introduction,
    folders: read
      .page
      .children
      .iter()
      .map(|folder| WorkspaceIndexFolder {
        title: folder.name.clone(),
        href: public_folder_path(workspace_id, &folder.id),
      })
      .collect(),
    items: read
      .page
      .documents
      .iter()
      .map(|doc| WorkspaceIndexItem {
        register: myoxus_application::workspace_overview::public_register_values(doc, &read.page),
        href: Some(public_document_path(
          doc.reference.workspace_id(),
          doc.reference.resource_id(),
        )),
        doc_id: doc.doc_id,
        route_key: doc.reference.resource_id().to_string(),
        title: doc.title.clone(),
        public_mode: doc.public_mode.clone().unwrap_or_else(|| "Page".to_string()),
      })
      .collect(),
  };
  let mut options = html_options(&state, workspace_id, &path, allow.noindex);
  if read.page.folder.is_some() {
    options.site_shell.breadcrumbs.push(PublicBreadcrumb {
      label: index.title.clone(),
      href: Some(format!("/public/{workspace_id}")),
    });
    for (position, folder) in read.page.breadcrumbs.iter().enumerate() {
      options.site_shell.breadcrumbs.push(PublicBreadcrumb {
        label: folder.name.clone(),
        href: (position + 1 < read.page.breadcrumbs.len()).then(|| public_folder_path(workspace_id, &folder.id)),
      });
    }
  }
  let renderer = state.html_renderer().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let rendered = render_workspace_index_html(&renderer, &index, &options).map_err(|err| {
    warn!(%workspace_id, error = %err, "public workspace render failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;
  // The existing artifact key owns the root index only. Folder reads must not
  // overwrite it or manufacture document IDs for derived pages.
  if read.page.folder.is_none() && read.register_page.offset == 0 && read.register_page.limit == 50 {
    let source = serde_json::to_vec(&index).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    service
      .upsert_artifact(&artifact_for_html(
        workspace_id,
        None,
        source_hash(&source),
        allow.noindex,
        json!(assets),
        rendered.html.clone(),
        renderer.renderer_version(PUBLIC_RENDERER_VERSION),
      ))
      .await
      .map_err(|err| {
        warn!(%workspace_id, error = %err, "public workspace artifact write failed");
        StatusCode::INTERNAL_SERVER_ERROR
      })?;
  }
  info!(%workspace_id, outcome = "allow", cache_status = "rendered", "public workspace route served");
  Ok(html_response(&state, rendered.html, allow.noindex))
}

#[instrument(skip_all, fields(workspace_id = %workspace_id, doc_id = %doc_id, route = "/public/{workspace_id}/{doc_id}"))]
pub(crate) async fn public_document_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
  if !state.config.public_publishing.enabled || !state.config.public_publishing.dynamic_routes_enabled {
    return Err(StatusCode::NOT_FOUND);
  }
  let workspace_id = parse_uuid(&workspace_id)?;
  let resolved_doc_id = resolve_public_route_doc_id(&state, workspace_id, &doc_id).await?;
  render_public_document(&state, workspace_id, resolved_doc_id, &doc_id).await
}

async fn render_public_document(
  state: &ApiState,
  workspace_id: Uuid,
  doc_id: Uuid,
  route_doc_id: &str,
) -> Result<Response, StatusCode> {
  let service = public_service(state)?;
  let LoadedPublicDocument {
    ir,
    allow,
    assets,
    artifact_source_hash,
  } = load_public_document(state, &service, workspace_id, doc_id).await?;
  let public_mode = allow.public_mode.as_deref().unwrap_or("Page");
  let path = public_document_path(workspace_id, route_doc_id);
  let mut options = html_options(state, workspace_id, &path, allow.noindex);
  options.site_shell.breadcrumbs = vec![
    PublicBreadcrumb {
      label: allow
        .workspace_title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Workspace".to_string()),
      href: Some(format!("/public/{workspace_id}")),
    },
    PublicBreadcrumb {
      label: ir.document.title.clone(),
      href: None,
    },
  ];
  let renderer = state.html_renderer().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  let rendered = render_document_html(&renderer, &ir, &options).map_err(|err| {
    warn!(%workspace_id, %doc_id, error = %err, outcome = "error", "public doc render failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;
  service
    .upsert_artifact(&artifact_for_html(
      workspace_id,
      Some(doc_id),
      artifact_source_hash,
      allow.noindex,
      json!(assets),
      rendered.html.clone(),
      renderer.renderer_version(PUBLIC_RENDERER_VERSION),
    ))
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, outcome = "error", "public doc artifact write failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
  info!(
    %workspace_id,
    %doc_id,
    public_mode,
    renderer_version = renderer.renderer_version(PUBLIC_RENDERER_VERSION),
    theme_version = DEFAULT_PUBLIC_THEME_VERSION,
    outcome = "allow",
    cache_status = "rendered",
    "public document route served"
  );
  Ok(html_response(state, rendered.html, allow.noindex))
}

struct LoadedPublicDocument {
  ir: PublicDocIr,
  allow: PublicAllow,
  assets: Vec<PublicAssetManifestEntry>,
  artifact_source_hash: String,
}

/// Introductions use the same native body, current document ACL and media
/// manifest as standalone public documents; overview bindings grant no access.
async fn load_public_document(
  state: &ApiState,
  service: &PublicService<PgPublicRepository>,
  workspace_id: Uuid,
  doc_id: Uuid,
) -> Result<LoadedPublicDocument, StatusCode> {
  let doc = state
    .doc()
    .load_full_doc_with_meta(workspace_id, doc_id)
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, outcome = "error", "public doc load failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
  if !doc.exists {
    return Err(StatusCode::NOT_FOUND);
  }
  let allow = service
    .decide_document(workspace_id, doc_id, &doc.payload)
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, outcome = "error", "public doc ACL failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .allowed()
    .ok_or(StatusCode::NOT_FOUND)?;
  let public_mode = allow.public_mode.as_deref().unwrap_or("Page");
  let fallback_title = allow.title.as_deref().unwrap_or("Untitled public document");
  let mut ir = document_from_yjs(workspace_id, doc_id, fallback_title, public_mode, &doc.payload).map_err(|err| {
    warn!(%workspace_id, %doc_id, error = %err, outcome = "error", "public doc IR extraction failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;
  let metadata_projection = state
    .document_metadata_service()
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
    .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, "public document metadata projection failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
  let metadata_definitions = state
    .document_metadata_policy_repo()
    .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
    .list_metadata_field_definitions()
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, "public document metadata definitions failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
  ir.document.metadata_badges = document_metadata_badges(&metadata_projection, &metadata_definitions);
  let badge_projection = serde_json::to_string(&ir.document.metadata_badges).map_err(|err| {
    warn!(%workspace_id, %doc_id, error = %err, "public document metadata serialization failed");
    StatusCode::INTERNAL_SERVER_ERROR
  })?;
  let artifact_source_hash = source_hash(format!("{}\0{badge_projection}", allow.source_hash).as_bytes());
  let assets = materialize_public_assets(state, service, workspace_id, doc_id, &mut ir).await?;
  Ok(LoadedPublicDocument {
    ir,
    allow,
    assets,
    artifact_source_hash,
  })
}

async fn materialize_public_assets(
  state: &ApiState,
  service: &PublicService<PgPublicRepository>,
  workspace_id: Uuid,
  doc_id: Uuid,
  ir: &mut myoxus_public_render::PublicDocIr,
) -> Result<Vec<myoxus_application::public::PublicAssetManifestEntry>, StatusCode> {
  let mut manifest = Vec::new();
  for candidate in resolve_asset_candidates(ir) {
    let metadata = state
      .blob()
      .get_blob_metadata(workspace_id, &candidate.blob_key)
      .await
      .map_err(|err| {
        warn!(
          %workspace_id,
          %doc_id,
          blob_key = %candidate.blob_key,
          error = %err,
          "public asset metadata lookup failed"
        );
        StatusCode::INTERNAL_SERVER_ERROR
      })?;
    let Some(metadata) = metadata else {
      warn!(%workspace_id, %doc_id, blob_key = %candidate.blob_key, "public asset referenced but not found");
      continue;
    };
    let public_url = format!(
      "/public-assets/{workspace_id}/{doc_id}/{}/{}",
      candidate.asset_hash, candidate.filename
    );
    apply_public_asset_url(ir, &candidate.blob_key, &public_url);
    manifest.push(asset_manifest_entry(
      workspace_id,
      doc_id,
      candidate.asset_hash,
      candidate.filename,
      candidate.blob_key,
      metadata.mime,
      metadata.size as i64,
      Some(metadata.updated_at),
    ));
  }
  service
    .replace_asset_manifest(workspace_id, doc_id, &manifest)
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, "public asset manifest write failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?;
  Ok(manifest)
}

#[instrument(skip_all, fields(workspace_id = %workspace_id, doc_id = %doc_id, asset_hash = %asset_hash))]
pub(crate) async fn public_asset_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id, asset_hash, filename)): Path<(String, String, String, String)>,
) -> Result<Response, StatusCode> {
  if !state.config.public_publishing.enabled || !state.config.public_publishing.dynamic_routes_enabled {
    return Err(StatusCode::NOT_FOUND);
  }
  let workspace_id = parse_uuid(&workspace_id)?;
  // Asset manifests own the internal document ID, independently of the public external route key.
  let doc_id = parse_uuid(&doc_id)?;
  let service = public_service(&state)?;
  if service
    .decide_document(workspace_id, doc_id, b"asset")
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, error = %err, "public asset ACL failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .allowed()
    .is_none()
  {
    return Err(StatusCode::NOT_FOUND);
  }
  let asset = service
    .get_asset(workspace_id, doc_id, &asset_hash, &filename)
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, %asset_hash, %filename, error = %err, "public asset manifest lookup failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .ok_or(StatusCode::NOT_FOUND)?;
  let blob = state
    .blob()
    .get_blob(workspace_id, &asset.blob_key)
    .await
    .map_err(|err| {
      warn!(%workspace_id, %doc_id, blob_key = %asset.blob_key, error = %err, "public asset blob read failed");
      StatusCode::NOT_FOUND
    })?;
  let mut response = blob.data.to_vec().into_response();
  response.headers_mut().insert(
    header::CONTENT_TYPE,
    asset
      .content_type
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response.headers_mut().insert(
    header::CACHE_CONTROL,
    asset
      .cache_control
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  response
    .headers_mut()
    .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
  Ok(response)
}

#[instrument(skip_all, fields(workspace_id = %workspace_id, doc_id = %doc_id, route = "/share/{workspace_id}/{doc_id}"))]
pub(crate) async fn legacy_share_redirect_handler(
  State(state): State<ApiState>,
  Path((workspace_id, doc_id)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
  let workspace_id = parse_uuid(&workspace_id)?;
  let route_doc_id = doc_id;
  let doc_id = resolve_public_route_doc_id(&state, workspace_id, &route_doc_id).await?;
  let doc = state
    .doc()
    .load_full_doc_with_meta(workspace_id, doc_id)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
  let service = public_service(&state)?;
  let allow = service
    .decide_document(workspace_id, doc_id, &doc.payload)
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?
    .allowed()
    .ok_or(StatusCode::NOT_FOUND)?;
  debug!(
    %workspace_id,
    %doc_id,
    public_mode = ?allow.public_mode,
    outcome = "redirect",
    "legacy share route redirected to public route"
  );
  Ok(Redirect::temporary(&format!("/public/{workspace_id}/{route_doc_id}")).into_response())
}

#[allow(dead_code)]
fn _header_map_does_not_log_sensitive_headers(_: &HeaderMap) {}
