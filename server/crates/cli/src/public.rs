//! HTML snapshot commands for public-renderer diagnostics and experiments.
//!
//! The product publishing path is dynamic API rendering through `/public/...`.
//! This CLI materializes the same renderer into a versioned directory, but it
//! must not be treated as the canonical live-publication mechanism without an
//! explicit product decision.

mod overview;

use std::{
  collections::BTreeSet,
  fs,
  io::{Read, Write},
  path::{Path, PathBuf},
  sync::Arc,
};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use clap::Subcommand;
use myoxus_application::{
  ports::blob_service::BlobService,
  public::{
    DEFAULT_PUBLIC_THEME_VERSION, PUBLIC_ASSET_CACHE_CONTROL, PUBLIC_RENDERER_VERSION, PublicService, source_hash,
  },
  workspace_overview::WorkspaceOverviewSource,
};
use myoxus_infrastructure::{
  blob::SqlxBlobStore,
  branding::{build_runtime_theme_css, list_font_families, load_effective_theme_profile, load_organization_identity},
  public::PgPublicRepository,
  storage::StorageAdapter,
};
use myoxus_public_render::{
  HtmlRenderOptions, HtmlRenderer, PublicAdjacentPage, PublicBreadcrumb, PublicSiteShellOptions, SocialCardFonts,
  SocialCardInput, SocialCardTheme, apply_public_asset_url, document_from_yjs, public_document_path,
  render_document_html, render_social_card_png, resolve_asset_candidates,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tracing::{info, instrument};
use uuid::Uuid;

use crate::services::Services;
use overview::{SnapshotIntroductions, SnapshotOverviewWriter, overview_reader, snapshot_document_segment};

#[derive(Subcommand)]
pub enum PublicCommand {
  /// Render currently public workspaces and documents into an HTML snapshot.
  Export(PublicExportArgs),
  /// Switch `current` to an already exported HTML snapshot after ACL validation.
  ActivateRelease(PublicActivateReleaseArgs),
}

#[derive(clap::Args)]
pub struct PublicExportArgs {
  /// Root directory for HTML snapshot output, for example /var/lib/myoxus/public.
  #[arg(long)]
  output_root: PathBuf,

  /// Filesystem blob storage root used by local/self-hosted deployments.
  #[arg(long, default_value = "/var/lib/myoxus/storage")]
  storage_root: PathBuf,

  /// Public origin used for canonical and Open Graph URLs.
  #[arg(long)]
  public_origin: Option<String>,

  /// Pagefind executable used to generate snapshot search artifacts.
  #[arg(long, default_value = "pagefind")]
  pagefind_binary: String,

  /// Skip Pagefind generation even when public pages were included.
  #[arg(long)]
  skip_pagefind: bool,

  /// Skip PNG social-card generation.
  #[arg(long)]
  skip_social_cards: bool,
}

#[derive(clap::Args)]
pub struct PublicActivateReleaseArgs {
  /// Release ID below <output-root>/releases.
  #[arg(long)]
  release_id: String,

  /// Root directory for HTML snapshot output, for example /var/lib/myoxus/public.
  #[arg(long)]
  output_root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct PublicExportManifest {
  export_id: String,
  generated_at: DateTime<Utc>,
  renderer_version: String,
  theme_version: String,
  noindex: bool,
  workspace_routes: Vec<PublicWorkspaceRoute>,
  document_routes: Vec<PublicDocumentRoute>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PublicWorkspaceRoute {
  workspace_id: Uuid,
  route: String,
  title: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  folder_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PublicDocumentRoute {
  workspace_id: Uuid,
  doc_id: Uuid,
  route: String,
  title: String,
  public_mode: String,
  source_hash: String,
  assets: Vec<PublicStaticAsset>,
  social_card_route: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PublicStaticAsset {
  asset_hash: String,
  filename: String,
  blob_key: String,
  route: String,
  content_type: String,
  size_bytes: i64,
  cache_control: String,
}

#[derive(Debug, Clone)]
struct PublicDocumentRow {
  workspace_id: Uuid,
  doc_id: Uuid,
  route_key: String,
  title: String,
  public_mode: String,
}

#[derive(Clone)]
struct PublicExportBranding {
  brand: String,
  social_card_theme: SocialCardTheme,
  social_card_fonts: std::sync::Arc<SocialCardFonts>,
}

pub async fn run(cmd: PublicCommand, services: &Services) -> Result<()> {
  match cmd {
    PublicCommand::Export(args) => export_public(args, services).await,
    PublicCommand::ActivateRelease(args) => activate_release(args, services).await,
  }
}

#[instrument(skip_all, fields(output_root = %args.output_root.display()))]
async fn export_public(mut args: PublicExportArgs, services: &Services) -> Result<()> {
  let origin = args
    .public_origin
    .get_or_insert_with(|| services.server_origin().to_string());
  let parsed = reqwest::Url::parse(origin).context("public origin must be an absolute HTTP(S) URL")?;
  if !matches!(parsed.scheme(), "http" | "https")
    || parsed.host_str().is_none()
    || !parsed.username().is_empty()
    || parsed.password().is_some()
    || parsed.query().is_some()
    || parsed.fragment().is_some()
  {
    bail!("public origin must be an absolute HTTP(S) URL without credentials, query or fragment");
  }
  let export_id = format!("{}-{}", Utc::now().format("%Y%m%dT%H%M%SZ"), Uuid::new_v4());
  let releases_root = args.output_root.join("releases");
  let staging_dir = releases_root.join(format!("{export_id}.staging"));
  let release_dir = releases_root.join(&export_id);
  if staging_dir.exists() || release_dir.exists() {
    bail!("release directory already exists for export id {export_id}");
  }
  fs::create_dir_all(&staging_dir).with_context(|| format!("create staging dir {}", staging_dir.display()))?;

  let result = export_public_into_staging(&args, services, &staging_dir, &export_id).await;
  match result {
    Ok(manifest) => {
      fs::rename(&staging_dir, &release_dir).with_context(|| {
        format!(
          "promote staging release {} to {}",
          staging_dir.display(),
          release_dir.display()
        )
      })?;
      switch_current_symlink(&args.output_root, &release_dir)?;
      info!(
        export_id,
        workspace_routes = manifest.workspace_routes.len(),
        document_routes = manifest.document_routes.len(),
        "public HTML snapshot completed"
      );
      println!(
        "Exported public HTML snapshot {export_id}: {} workspaces, {} documents",
        manifest
          .workspace_routes
          .iter()
          .filter(|route| route.folder_id.is_none())
          .count(),
        manifest.document_routes.len()
      );
      Ok(())
    }
    Err(err) => {
      let _ = fs::remove_dir_all(&staging_dir);
      Err(err)
    }
  }
}

async fn export_public_into_staging(
  args: &PublicExportArgs,
  services: &Services,
  staging_dir: &Path,
  export_id: &str,
) -> Result<PublicExportManifest> {
  let renderer = services.html_catalog.renderer().map_err(anyhow::Error::msg)?;
  let theme_file = format!("theme-{DEFAULT_PUBLIC_THEME_VERSION}.css");
  write_theme_css(staging_dir, &theme_file, &services.pool).await?;
  write_public_shell_assets(staging_dir, &renderer)?;

  let (workspaces, documents) = load_public_projection(services).await?;
  let public = PublicService::new(PgPublicRepository::new(services.pool.clone()));
  let introduction_ids = workspaces
    .iter()
    .flat_map(|source| {
      let settings = &source.workspace.overview_settings;
      settings
        .introduction
        .iter()
        .chain(
          settings
            .folders
            .values()
            .filter_map(|folder| folder.introduction.as_ref()),
        )
        .filter_map(|reference| {
          source
            .documents
            .iter()
            .find(|document| document.is_page && document.reference == *reference)
            .map(|document| document.doc_id)
        })
    })
    .collect::<BTreeSet<_>>();
  let mut introductions = SnapshotIntroductions::new();
  let export_branding = load_public_export_branding(&services.pool, !args.skip_social_cards).await?;
  let default_locale = services.default_locale();
  let mut manifest = PublicExportManifest {
    export_id: export_id.to_string(),
    generated_at: Utc::now(),
    renderer_version: renderer.renderer_version(PUBLIC_RENDERER_VERSION),
    theme_version: DEFAULT_PUBLIC_THEME_VERSION.to_string(),
    noindex: false,
    workspace_routes: Vec::new(),
    document_routes: Vec::new(),
  };

  let blob_service = export_blob_service(&services.pool, &args.storage_root)?;
  for doc in documents.iter() {
    let loaded = services
      .doc
      .load_full_doc_with_meta(doc.workspace_id, doc.doc_id)
      .await
      .with_context(|| format!("load public document {} in workspace {}", doc.doc_id, doc.workspace_id))?;
    if !loaded.exists {
      bail!(
        "public document {} in workspace {} disappeared during snapshot export",
        doc.doc_id,
        doc.workspace_id
      );
    }
    if public
      .decide_document(doc.workspace_id, doc.doc_id, &loaded.payload)
      .await?
      .allowed()
      .is_none()
    {
      bail!(
        "document {} in workspace {} is no longer public",
        doc.doc_id,
        doc.workspace_id
      );
    }
    myoxus_application::document_fields::validate_snapshot(&loaded.payload)?;
    let mut ir = document_from_yjs(
      doc.workspace_id,
      doc.doc_id,
      &doc.title,
      &doc.public_mode,
      &loaded.payload,
    )
    .map_err(|err| anyhow!("extract public IR for {}: {err}", doc.doc_id))?;
    let assets = write_public_assets(staging_dir, &blob_service, doc.workspace_id, doc.doc_id, &mut ir).await?;
    if introduction_ids.contains(&doc.doc_id) {
      introductions.insert(doc.doc_id, (ir.clone(), assets.clone()));
    }
    let route = format!(
      "/public/{}/{}",
      doc.workspace_id,
      snapshot_document_segment(&doc.route_key)
    );
    let canonical_route = public_document_path(doc.workspace_id, &doc.route_key);
    let social_card_route = if args.skip_social_cards {
      None
    } else {
      let workspace_title = workspaces
        .iter()
        .find(|workspace| workspace.workspace.id == doc.workspace_id)
        .map(|workspace| workspace.workspace.name.as_str())
        .unwrap_or("Public workspace");
      Some(write_social_card(
        &renderer,
        staging_dir,
        doc.workspace_id,
        doc.doc_id,
        &doc.title,
        workspace_title,
        &export_branding,
      )?)
    };
    let rendered = render_document_html(
      &renderer,
      &ir,
      &html_options(
        args,
        &canonical_route,
        &format!("../../../theme/{theme_file}"),
        "../../../favicon.ico",
        &default_locale,
        {
          let (previous, next) = adjacent_pages(&documents, doc.workspace_id, doc.doc_id);
          let workspace_title = workspaces
            .iter()
            .find(|workspace| workspace.workspace.id == doc.workspace_id)
            .map(|workspace| workspace.workspace.name.clone())
            .unwrap_or_else(|| "Workspace".to_string());
          PublicSiteShellOptions {
            asset_base_url: Some("../../../assets".to_string()),
            search_bundle_url: search_bundle_url(args, "../../../"),
            social_card_url: social_card_route.as_ref().map(|route| snapshot_social_card_url(route)),
            footer_note: None,
            breadcrumbs: vec![
              PublicBreadcrumb {
                label: workspace_title,
                href: Some("../index.html".to_string()),
              },
              PublicBreadcrumb {
                label: doc.title.clone(),
                href: None,
              },
            ],
            previous,
            next,
            ..PublicSiteShellOptions::default()
          }
        },
      ),
    )
    .map_err(|err| anyhow!("render public document {}: {err}", doc.doc_id))?;
    write_html(staging_dir, &route, &rendered.html)?;
    manifest.document_routes.push(PublicDocumentRoute {
      workspace_id: doc.workspace_id,
      doc_id: doc.doc_id,
      route,
      title: doc.title.clone(),
      public_mode: doc.public_mode.clone(),
      source_hash: source_hash(&loaded.payload),
      assets,
      social_card_route,
    });
  }

  let emitted = manifest
    .document_routes
    .iter()
    .map(|doc| (doc.workspace_id, doc.doc_id))
    .collect();
  let overview_writer = SnapshotOverviewWriter {
    args,
    renderer,
    staging_dir,
    theme_file: &theme_file,
    locale: &default_locale,
    introductions: &introductions,
    emitted: &emitted,
    source_origin: services.server_origin(),
  };
  for source in workspaces {
    manifest.workspace_routes.extend(overview_writer.write(source)?);
  }
  if !args.skip_pagefind {
    run_pagefind(staging_dir, &args.pagefind_binary)?;
  }

  // Search generation may take time. Recheck the existing ACL boundary last,
  // including folders whose final eligible introduction/document was revoked.
  validate_release_public_acl(services, &manifest).await?;

  let manifest_path = staging_dir.join("manifest.json");
  fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)
    .with_context(|| format!("write {}", manifest_path.display()))?;
  Ok(manifest)
}

async fn activate_release(args: PublicActivateReleaseArgs, services: &Services) -> Result<()> {
  let release_dir = args.output_root.join("releases").join(&args.release_id);
  let manifest_path = release_dir.join("manifest.json");
  let manifest: PublicExportManifest =
    serde_json::from_slice(&fs::read(&manifest_path).with_context(|| format!("read {}", manifest_path.display()))?)
      .with_context(|| format!("parse {}", manifest_path.display()))?;
  validate_release_public_acl(services, &manifest).await?;
  switch_current_symlink(&args.output_root, &release_dir)?;
  info!(
    export_id = %manifest.export_id,
    workspace_routes = manifest.workspace_routes.len(),
    document_routes = manifest.document_routes.len(),
    "public HTML snapshot activated"
  );
  println!("Activated public HTML snapshot {}", manifest.export_id);
  Ok(())
}

async fn load_public_projection(services: &Services) -> Result<(Vec<WorkspaceOverviewSource>, Vec<PublicDocumentRow>)> {
  let public = PublicService::new(PgPublicRepository::new(services.pool.clone()));
  let reader = overview_reader(services);
  let mut sources = Vec::new();
  let mut documents = Vec::new();
  for workspace in public
    .list_public_workspaces()
    .await
    .context("load eligible public workspaces")?
  {
    let source = reader.read_public_source(&public, workspace.workspace_id).await?;
    documents.extend(
      source
        .documents
        .iter()
        .filter(|document| document.reference.workspace_id() == source.workspace.id)
        .map(|document| PublicDocumentRow {
          workspace_id: source.workspace.id,
          doc_id: document.doc_id,
          route_key: document.reference.resource_id().to_string(),
          title: document.title.clone(),
          public_mode: document.public_mode.clone().unwrap_or_else(|| "Page".into()),
        }),
    );
    sources.push(source);
  }
  Ok((sources, documents))
}

async fn load_public_export_branding(pool: &PgPool, render_cards: bool) -> Result<PublicExportBranding> {
  let theme_profile = load_effective_theme_profile(pool, None)
    .await
    .context("load global theme projection for public social cards")?;
  let identity = load_organization_identity(pool)
    .await
    .context("load organization identity for public social cards")?;
  let brand = identity
    .short_name
    .as_deref()
    .or(identity.display_name.as_deref())
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("Myoxus")
    .to_string();
  let mut social_card_theme = SocialCardTheme::from_theme_colors(&theme_profile.theme.colors, &brand);
  if let Some(heading) = theme_profile
    .theme
    .typography_styles
    .iter()
    .find(|style| style.style_key == "heading.h1")
  {
    social_card_theme.font_family = heading.css_family.clone();
  }
  let mut social_card_fonts = SocialCardFonts::new();
  if render_cards {
    let family_name = social_card_theme
      .font_family
      .split(',')
      .next()
      .unwrap_or("")
      .trim()
      .trim_matches(['\'', '"']);
    let families = list_font_families(pool, true)
      .await
      .context("load social-card font catalog")?;
    let family = families
      .iter()
      .find(|family| {
        family
          .css_family
          .split(',')
          .next()
          .unwrap_or("")
          .trim()
          .trim_matches(['\'', '"'])
          == family_name
      })
      .ok_or_else(|| anyhow!("social-card theme font is not registered"))?;
    let mut total_bytes = 0;
    for asset in family
      .assets
      .iter()
      .filter(|asset| asset.usage == "pdf" && matches!(asset.format.as_str(), "ttf" | "otf" | "variable_ttf"))
    {
      let filename = Path::new(&asset.asset_key)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| *name == asset.asset_key)
        .ok_or_else(|| anyhow!("invalid social-card font asset key"))?;
      let file = fs::File::open(bundled_fonts_dir().join(filename)).context("read registered social-card font")?;
      let mut bytes = Vec::new();
      file
        .take((32 * 1024 * 1024 - total_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .context("capture registered social-card font")?;
      total_bytes += bytes.len();
      if bytes.is_empty() || total_bytes > 32 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != asset.sha256 {
        bail!("social-card font bytes exceed limit or differ from registered hash");
      }
      social_card_fonts.load_font_data(bytes);
    }
    if social_card_fonts.is_empty() {
      bail!("social-card theme font has no raster assets");
    }
  }
  Ok(PublicExportBranding {
    social_card_theme,
    social_card_fonts: std::sync::Arc::new(social_card_fonts),
    brand,
  })
}

async fn validate_release_public_acl(services: &Services, manifest: &PublicExportManifest) -> Result<()> {
  let public = PublicService::new(PgPublicRepository::new(services.pool.clone()));
  let reader = overview_reader(services);
  let workspace_ids = manifest
    .workspace_routes
    .iter()
    .map(|route| route.workspace_id)
    .chain(manifest.document_routes.iter().map(|route| route.workspace_id))
    .collect::<BTreeSet<_>>();
  for workspace_id in workspace_ids {
    let source = reader
      .read_public_source(&public, workspace_id)
      .await
      .with_context(|| {
        format!(
          "release {} contains a workspace which is no longer public",
          manifest.export_id
        )
      })?;
    let readable = source
      .documents
      .iter()
      .filter(|doc| doc.reference.workspace_id() == workspace_id)
      .map(|doc| doc.doc_id)
      .collect::<BTreeSet<_>>();
    for document in manifest
      .document_routes
      .iter()
      .filter(|doc| doc.workspace_id == workspace_id)
    {
      if !readable.contains(&document.doc_id) {
        bail!(
          "release {} contains document {} which is no longer public",
          manifest.export_id,
          document.doc_id
        );
      }
    }
    let overview = myoxus_application::workspace_overview::compose_workspace_overview(
      &source.organizer,
      &source.workspace.overview_settings,
      source.documents,
      true,
    )?;
    for route in manifest
      .workspace_routes
      .iter()
      .filter(|route| route.workspace_id == workspace_id)
    {
      if let Some(folder_id) = &route.folder_id {
        overview.page(&source.organizer, Some(folder_id)).with_context(|| {
          format!(
            "release {} contains a folder which is no longer public",
            manifest.export_id
          )
        })?;
      }
    }
  }
  Ok(())
}

fn export_blob_service(pool: &PgPool, storage_root: &Path) -> Result<BlobService> {
  let storage_root = storage_root
    .to_str()
    .ok_or_else(|| anyhow!("storage root is not valid UTF-8: {}", storage_root.display()))?;
  let storage = Arc::new(StorageAdapter::new_fs(storage_root)?);
  let store = Arc::new(SqlxBlobStore::new(pool.clone()));
  Ok(BlobService::new(store, storage, "public-export".to_string()))
}

async fn write_public_assets(
  staging_dir: &Path,
  blob_service: &BlobService,
  workspace_id: Uuid,
  doc_id: Uuid,
  ir: &mut myoxus_public_render::PublicDocIr,
) -> Result<Vec<PublicStaticAsset>> {
  let mut assets = Vec::new();
  for candidate in resolve_asset_candidates(ir) {
    let public_route = format!(
      "/public-assets/{workspace_id}/{doc_id}/{}/{}",
      candidate.asset_hash, candidate.filename
    );
    let blob = blob_service
      .get_blob(workspace_id, &candidate.blob_key)
      .await
      .with_context(|| format!("read public asset blob {}", candidate.blob_key))?;
    let output_path = staging_dir.join(public_route.trim_start_matches('/'));
    if let Some(parent) = output_path.parent() {
      fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(&output_path, &blob.data).with_context(|| format!("write {}", output_path.display()))?;
    apply_public_asset_url(
      ir,
      &candidate.blob_key,
      &format!("../../../{}", public_route.trim_start_matches('/')),
    );
    assets.push(PublicStaticAsset {
      asset_hash: candidate.asset_hash,
      filename: candidate.filename,
      blob_key: candidate.blob_key,
      route: public_route,
      content_type: blob
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string()),
      size_bytes: blob.data.len() as i64,
      cache_control: PUBLIC_ASSET_CACHE_CONTROL.to_string(),
    });
  }
  Ok(assets)
}

fn html_options(
  args: &PublicExportArgs,
  route: &str,
  theme_css_url: &str,
  favicon_url: &str,
  locale: &str,
  site_shell: PublicSiteShellOptions,
) -> HtmlRenderOptions {
  HtmlRenderOptions {
    canonical_url: canonical_public_url(args.public_origin.as_deref(), route),
    theme_css_url: theme_css_url.to_string(),
    favicon_url: favicon_url.to_string(),
    noindex: false,
    locale: locale.to_string(),
    snapshot_relative_links: true,
    site_shell,
  }
}

fn canonical_public_url(public_origin: Option<&str>, route: &str) -> String {
  public_origin
    .map(|origin| format!("{}{}", origin.trim_end_matches('/'), route))
    .unwrap_or_else(|| route.to_string())
}

fn snapshot_social_card_url(route: &str) -> String {
  // Canonical SEO keeps the configured origin, while the exported image must
  // travel with its release rather than point at an API-only host.
  format!("../../../{}", route.trim_start_matches('/'))
}

fn write_html(staging_dir: &Path, route: &str, html: &str) -> Result<()> {
  let output_path = staging_dir.join(route.trim_start_matches('/')).join("index.html");
  if let Some(parent) = output_path.parent() {
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
  }
  // A generated route must own a new file, including on filesystems whose
  // case-folding would otherwise alias two distinct external document keys.
  let mut output = fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&output_path)
    .with_context(|| format!("create unique snapshot route {}", output_path.display()))?;
  output
    .write_all(html.as_bytes())
    .with_context(|| format!("write {}", output_path.display()))
}

async fn write_theme_css(staging_dir: &Path, theme_file: &str, pool: &PgPool) -> Result<()> {
  let theme_dir = staging_dir.join("theme");
  fs::create_dir_all(&theme_dir).with_context(|| format!("create {}", theme_dir.display()))?;
  let theme_path = theme_dir.join(theme_file);
  let theme_profile = load_effective_theme_profile(pool, None)
    .await
    .context("load global theme projection for public HTML snapshot CSS")?;
  let fonts = list_font_families(pool, true)
    .await
    .context("load font catalog for public HTML snapshot CSS")?;
  let fonts_dir = staging_dir.join("fonts");
  fs::create_dir_all(&fonts_dir).with_context(|| format!("create {}", fonts_dir.display()))?;
  let bundled_fonts = bundled_fonts_dir();
  for asset in fonts
    .iter()
    .flat_map(|family| family.assets.iter())
    .filter(|asset| asset.usage == "web" && asset.format == "woff2")
  {
    let filename = Path::new(&asset.asset_key)
      .file_name()
      .and_then(|filename| filename.to_str())
      .filter(|filename| *filename == asset.asset_key)
      .ok_or_else(|| anyhow!("snapshot font asset key is not a bundled filename: {}", asset.asset_key))?;
    let source = bundled_fonts.join(filename);
    let bytes = fs::read(&source).with_context(|| format!("read bundled snapshot font {}", source.display()))?;
    if format!("{:x}", Sha256::digest(&bytes)) != asset.sha256 {
      bail!("snapshot font hash mismatch for {filename}");
    }
    fs::write(fonts_dir.join(filename), bytes).with_context(|| format!("write snapshot font {filename}"))?;
  }
  // HTML snapshots must be self-contained. This file is the same server-owned
  // projection served dynamically by `/api/branding/theme.css`, not a
  // Browser-Web fallback or an API import stub.
  let css = build_runtime_theme_css(&theme_profile, &fonts).replace("url('/api/fonts/", "url('../fonts/");
  fs::write(&theme_path, css).with_context(|| format!("write {}", theme_path.display()))
}

fn bundled_fonts_dir() -> PathBuf {
  let relative = PathBuf::from("static/fonts");
  if relative.is_dir() {
    return relative;
  }
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .and_then(Path::parent)
    .map(|server_root| server_root.join("static/fonts"))
    .unwrap_or(relative)
}

fn write_public_shell_assets(staging_dir: &Path, renderer: &HtmlRenderer) -> Result<()> {
  let assets_dir = staging_dir.join("assets");
  fs::create_dir_all(&assets_dir).with_context(|| format!("create {}", assets_dir.display()))?;
  fs::write(assets_dir.join("public.css"), renderer.public_css()).context("write public shell CSS")?;
  fs::write(assets_dir.join("public.js"), renderer.public_js()).context("write public shell JS")?;
  fs::write(
    staging_dir.join("favicon.ico"),
    include_bytes!("../../../../client/libs/core/public/favicon.ico"),
  )
  .context("write public snapshot favicon")?;
  Ok(())
}

fn write_social_card(
  renderer: &HtmlRenderer,
  staging_dir: &Path,
  workspace_id: Uuid,
  doc_id: Uuid,
  title: &str,
  workspace_title: &str,
  branding: &PublicExportBranding,
) -> Result<String> {
  let route = format!("/public-social/{workspace_id}/{doc_id}/card.png");
  let output_path = staging_dir.join(route.trim_start_matches('/'));
  if let Some(parent) = output_path.parent() {
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
  }
  let png = render_social_card_png(
    renderer,
    &SocialCardInput {
      title,
      subtitle: workspace_title,
      brand: &branding.brand,
      theme: branding.social_card_theme.clone(),
    },
    branding.social_card_fonts.clone(),
  )
  .map_err(|err| anyhow!("render social card for {doc_id}: {err}"))?;
  fs::write(&output_path, png).with_context(|| format!("write {}", output_path.display()))?;
  Ok(route)
}

fn search_bundle_url(args: &PublicExportArgs, root_prefix: &str) -> Option<String> {
  (!args.skip_pagefind).then(|| format!("{root_prefix}public-search/pagefind/pagefind.js"))
}

fn run_pagefind(staging_dir: &Path, pagefind_binary: &str) -> Result<()> {
  let output = std::process::Command::new(pagefind_binary)
    .arg("--site")
    .arg(staging_dir)
    .arg("--output-subdir")
    .arg("public-search/pagefind")
    .output()
    .with_context(|| format!("run Pagefind binary `{pagefind_binary}`"))?;
  if !output.status.success() {
    bail!(
      "Pagefind failed with status {}: {}",
      output.status,
      String::from_utf8_lossy(&output.stderr)
    );
  }
  Ok(())
}

fn adjacent_pages(
  documents: &[PublicDocumentRow],
  workspace_id: Uuid,
  doc_id: Uuid,
) -> (Option<PublicAdjacentPage>, Option<PublicAdjacentPage>) {
  let workspace_docs = documents
    .iter()
    .filter(|doc| doc.workspace_id == workspace_id)
    .collect::<Vec<_>>();
  let Some(position) = workspace_docs.iter().position(|doc| doc.doc_id == doc_id) else {
    return (None, None);
  };
  let previous = position
    .checked_sub(1)
    .and_then(|index| workspace_docs.get(index))
    .map(|doc| PublicAdjacentPage {
      label: doc.title.clone(),
      href: format!("../{}/index.html", snapshot_document_segment(&doc.route_key)),
    });
  let next = workspace_docs.get(position + 1).map(|doc| PublicAdjacentPage {
    label: doc.title.clone(),
    href: format!("../{}/index.html", snapshot_document_segment(&doc.route_key)),
  });
  (previous, next)
}

fn switch_current_symlink(output_root: &Path, release_dir: &Path) -> Result<()> {
  fs::create_dir_all(output_root).with_context(|| format!("create {}", output_root.display()))?;
  let current = output_root.join("current");
  let tmp = output_root.join(".current.tmp");
  remove_link_path(&tmp)?;
  create_symlink(release_dir, &tmp)?;
  assert_replaceable_current(&current)?;
  fs::rename(&tmp, &current).with_context(|| format!("switch current symlink {}", current.display()))?;
  Ok(())
}

fn assert_replaceable_current(path: &Path) -> Result<()> {
  match fs::symlink_metadata(path) {
    Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => Ok(()),
    Ok(metadata) if metadata.is_dir() => bail!("{} exists and is a directory, refusing to replace it", path.display()),
    Ok(_) => bail!("{} exists and is not a file or symlink", path.display()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err).with_context(|| format!("inspect {}", path.display())),
  }
}

fn remove_link_path(path: &Path) -> Result<()> {
  match fs::symlink_metadata(path) {
    Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
      fs::remove_file(path).with_context(|| format!("remove {}", path.display()))
    }
    Ok(metadata) if metadata.is_dir() => bail!("{} exists and is a directory, refusing to replace it", path.display()),
    Ok(_) => bail!("{} exists and is not a file or symlink", path.display()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err).with_context(|| format!("inspect {}", path.display())),
  }
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
  std::os::unix::fs::symlink(target, link)
    .with_context(|| format!("create symlink {} -> {}", link.display(), target.display()))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, _link: &Path) -> Result<()> {
  bail!("public HTML snapshot activation requires symlink support")
}
