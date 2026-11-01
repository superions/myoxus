//! SQLx-backed public publishing delivery repository.
//!
//! This module stores regenerable delivery artifacts only. The business source
//! of truth remains `docs.public_mode` and `workspaces.public`.

use async_trait::async_trait;
use myoxus_application::public::{
  DEFAULT_PUBLIC_THEME_VERSION, PUBLIC_ASSET_CACHE_CONTROL, PublicAclDecision, PublicAllow, PublicArtifact,
  PublicAssetManifestEntry, PublicDenyReason, PublicError, PublicRepository, PublicResult, PublicWorkspaceDoc,
  PublicWorkspaceProjection,
};
use serde_json::Value;
use sqlx::{PgPool, Row};
use tracing::{debug, instrument};
use uuid::Uuid;

#[derive(Clone)]
pub struct PgPublicRepository {
  pool: PgPool,
}

impl PgPublicRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_err(err: sqlx::Error) -> PublicError {
    PublicError::Repository(err.to_string())
  }
}

#[async_trait]
impl PublicRepository for PgPublicRepository {
  async fn list_public_workspaces(&self) -> PublicResult<Vec<PublicWorkspaceProjection>> {
    let rows = sqlx::query(
      r#"
      SELECT id, name, description
      FROM workspaces
      WHERE public = true
        AND enable_sharing = true
        AND deleted_at IS NULL
        AND lifecycle_state = 'active'
      ORDER BY updated_at DESC, id ASC
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| PublicWorkspaceProjection {
          workspace_id: row.get("id"),
          title: row.get("name"),
          description: row.get("description"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self))]
  async fn decide_workspace(&self, workspace_id: Uuid) -> PublicResult<PublicAclDecision> {
    let row = sqlx::query(
      r#"
      SELECT id, name, description, public, enable_sharing, deleted_at
      FROM workspaces
      WHERE id = $1 AND lifecycle_state = 'active'
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_err)?;
    let Some(row) = row else {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Missing));
    };
    if row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
      .is_some()
    {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Deleted));
    }
    if !row.get::<bool, _>("enable_sharing") {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::SharingDisabled));
    }
    if !row.get::<bool, _>("public") {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Private));
    }
    Ok(PublicAclDecision::Allow(PublicAllow {
      workspace_id,
      doc_id: None,
      public_mode: None,
      workspace_public: true,
      source_hash: workspace_id.to_string(),
      theme_version: DEFAULT_PUBLIC_THEME_VERSION.to_string(),
      noindex: false,
      title: Some(row.get("name")),
      workspace_title: Some(row.get("name")),
      workspace_description: row.get("description"),
    }))
  }

  #[instrument(skip(self, source_hash))]
  async fn decide_document(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    source_hash: String,
  ) -> PublicResult<PublicAclDecision> {
    let row = sqlx::query(
      r#"
      SELECT d.title, d.public_mode, d.blocked, d.deleted_at,
             w.name AS workspace_title, w.description AS workspace_description,
             w.public AS workspace_public, w.enable_sharing, w.deleted_at AS workspace_deleted_at
      FROM docs d
      JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.workspace_id = $1 AND d.id = $2
        AND w.lifecycle_state = 'active'
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_err)?;
    let Some(row) = row else {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Missing));
    };
    if row
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("workspace_deleted_at")
      .is_some()
      || row
        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
        .is_some()
    {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Deleted));
    }
    if row.get::<bool, _>("blocked") {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Blocked));
    }
    if !row.get::<bool, _>("enable_sharing") {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::SharingDisabled));
    }
    if !row.get::<bool, _>("workspace_public") {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Private));
    }
    let public_mode = row.get::<Option<String>, _>("public_mode");
    let Some(public_mode) = public_mode else {
      return Ok(PublicAclDecision::DenyNotFound(PublicDenyReason::Private));
    };
    Ok(PublicAclDecision::Allow(PublicAllow {
      workspace_id,
      doc_id: Some(doc_id),
      public_mode: Some(public_mode),
      workspace_public: row.get("workspace_public"),
      source_hash,
      theme_version: DEFAULT_PUBLIC_THEME_VERSION.to_string(),
      noindex: false,
      title: Some(row.get("title")),
      workspace_title: Some(row.get("workspace_title")),
      workspace_description: row.get("workspace_description"),
    }))
  }

  async fn list_public_workspace_docs(&self, workspace_id: Uuid) -> PublicResult<Vec<PublicWorkspaceDoc>> {
    let rows = sqlx::query(
      r#"
      SELECT d.id, d.external_id, d.title, d.public_mode, d.created_at, d.updated_at
      FROM docs d
      JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.workspace_id = $1
        AND d.public_mode IS NOT NULL
        AND d.deleted_at IS NULL
        AND d.blocked = false
        AND w.lifecycle_state = 'active'
        AND w.deleted_at IS NULL
        AND w.enable_sharing = true
        AND w.public = true
      ORDER BY d.updated_at DESC, d.title ASC, d.external_id ASC, d.id ASC
      "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| PublicWorkspaceDoc {
          doc_id: row.get("id"),
          route_key: row.get("external_id"),
          title: row.get("title"),
          public_mode: row.get("public_mode"),
          created_at: row.get("created_at"),
          updated_at: row.get("updated_at"),
        })
        .collect(),
    )
  }

  async fn upsert_artifact(&self, artifact: &PublicArtifact) -> PublicResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_err)?;
    sqlx::query(
      r#"
      DELETE FROM public_render_artifacts
      WHERE workspace_id = $1 AND doc_id IS NOT DISTINCT FROM $2
      "#,
    )
    .bind(artifact.workspace_id)
    .bind(artifact.doc_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_err)?;
    sqlx::query(
      r#"
      INSERT INTO public_render_artifacts
        (workspace_id, doc_id, source_hash, renderer_version, theme_version, noindex, asset_manifest, rendered_html)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      "#,
    )
    .bind(artifact.workspace_id)
    .bind(artifact.doc_id)
    .bind(&artifact.source_hash)
    .bind(&artifact.renderer_version)
    .bind(&artifact.theme_version)
    .bind(artifact.noindex)
    .bind(&artifact.asset_manifest)
    .bind(&artifact.rendered_html)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_err)?;
    tx.commit().await.map_err(Self::map_err)?;
    debug!(workspace_id = %artifact.workspace_id, doc_id = ?artifact.doc_id, "public artifact upserted");
    Ok(())
  }

  async fn invalidate_document(&self, workspace_id: Uuid, doc_id: Uuid) -> PublicResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_err)?;
    sqlx::query("DELETE FROM public_asset_manifest WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_err)?;
    sqlx::query("DELETE FROM public_render_artifacts WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_err)?;
    tx.commit().await.map_err(Self::map_err)?;
    Ok(())
  }

  async fn invalidate_workspace(&self, workspace_id: Uuid) -> PublicResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_err)?;
    sqlx::query("DELETE FROM public_asset_manifest WHERE workspace_id = $1")
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_err)?;
    sqlx::query("DELETE FROM public_render_artifacts WHERE workspace_id = $1")
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_err)?;
    tx.commit().await.map_err(Self::map_err)?;
    Ok(())
  }

  async fn replace_asset_manifest(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    assets: &[PublicAssetManifestEntry],
  ) -> PublicResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_err)?;
    sqlx::query("DELETE FROM public_asset_manifest WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_err)?;
    for asset in assets {
      sqlx::query(
        r#"
        INSERT INTO public_asset_manifest
          (workspace_id, doc_id, asset_hash, filename, blob_key, content_type, size_bytes, last_modified, cache_control)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        "#,
      )
      .bind(asset.workspace_id)
      .bind(asset.doc_id)
      .bind(&asset.asset_hash)
      .bind(&asset.filename)
      .bind(&asset.blob_key)
      .bind(&asset.content_type)
      .bind(asset.size_bytes)
      .bind(asset.last_modified)
      .bind(&asset.cache_control)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_err)?;
    }
    tx.commit().await.map_err(Self::map_err)?;
    Ok(())
  }

  async fn get_asset(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    asset_hash: &str,
    filename: &str,
  ) -> PublicResult<Option<PublicAssetManifestEntry>> {
    let row = sqlx::query(
      r#"
      SELECT workspace_id, doc_id, asset_hash, filename, blob_key, content_type,
             size_bytes, last_modified, cache_control
      FROM public_asset_manifest
      WHERE workspace_id = $1 AND doc_id = $2 AND asset_hash = $3 AND filename = $4
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(asset_hash)
    .bind(filename)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_err)?;
    Ok(row.map(|row| PublicAssetManifestEntry {
      workspace_id: row.get("workspace_id"),
      doc_id: row.get("doc_id"),
      asset_hash: row.get("asset_hash"),
      filename: row.get("filename"),
      blob_key: row.get("blob_key"),
      content_type: row.get("content_type"),
      size_bytes: row.get("size_bytes"),
      last_modified: row.get("last_modified"),
      cache_control: row.get("cache_control"),
    }))
  }
}

pub fn artifact_for_html(
  workspace_id: Uuid,
  doc_id: Option<Uuid>,
  source_hash: String,
  noindex: bool,
  asset_manifest: Value,
  rendered_html: String,
  renderer_version: String,
) -> PublicArtifact {
  PublicArtifact {
    workspace_id,
    doc_id,
    source_hash,
    renderer_version,
    theme_version: DEFAULT_PUBLIC_THEME_VERSION.to_string(),
    noindex,
    asset_manifest,
    rendered_html: Some(rendered_html),
  }
}

#[allow(clippy::too_many_arguments)]
pub fn asset_manifest_entry(
  workspace_id: Uuid,
  doc_id: Uuid,
  asset_hash: String,
  filename: String,
  blob_key: String,
  content_type: String,
  size_bytes: i64,
  last_modified: Option<chrono::DateTime<chrono::Utc>>,
) -> PublicAssetManifestEntry {
  PublicAssetManifestEntry {
    workspace_id,
    doc_id,
    asset_hash,
    filename,
    blob_key,
    content_type,
    size_bytes,
    last_modified,
    cache_control: PUBLIC_ASSET_CACHE_CONTROL.to_string(),
  }
}
