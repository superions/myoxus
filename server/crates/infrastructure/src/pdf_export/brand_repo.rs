// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed projection adapter for the workspace PDF document
//! branding and PDF export settings split.
//!
//! The domain projection is intentionally flat because the render-context code
//! consumes document branding and export settings together. This implementation
//! does not read or write the old mixed table; it composes
//! `organization_identity`, `document_brand_profiles`, `brand_assets` and
//! `pdf_export_settings`.

use crate::audit::PgAuditLogStore;
use async_trait::async_trait;
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{PdfDocumentBrandLogoSlot, PdfWorkspaceBrandAsset};
use myoxus_domain::repositories::{
  PdfDocumentBrandLogoAsset, PdfDocumentColorPalette, PdfExportSettingsPatch, PdfWorkspaceBrandAssetRepository,
  PdfWorkspaceDocumentBrandingReset, RepoResult, RepositoryError,
};

/// PostgreSQL-backed implementation of [`PdfWorkspaceBrandAssetRepository`].
#[derive(Debug, Clone)]
pub struct PgPdfWorkspaceBrandAssetRepository {
  pool: PgPool,
}

impl PgPdfWorkspaceBrandAssetRepository {
  /// Construct from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in pdf brand asset repository");
    RepositoryError::Storage(err.to_string())
  }

  fn map_row(row: sqlx::postgres::PgRow) -> PdfWorkspaceBrandAsset {
    PdfWorkspaceBrandAsset {
      workspace_id: row.get("workspace_id"),
      logo_large_blob: row.get("logo_large_blob"),
      logo_large_sha256: row.get("logo_large_sha256"),
      logo_small_blob: row.get("logo_small_blob"),
      logo_small_sha256: row.get("logo_small_sha256"),
      company_name: row.get("company_name"),
      legal_text: row.get("legal_text"),
      footer_text: row.get("footer_text"),
      color_policy: row
        .get::<Option<String>, _>("color_policy")
        .unwrap_or_else(|| "theme_palette".to_owned()),
      color_palette_key: row.get("color_palette_key"),
      brand_color_primary: row.get("brand_color_primary"),
      brand_color_accent: row.get("brand_color_accent"),
      brand_color_rule: row.get("brand_color_rule"),
      brand_color_text: row.get("brand_color_text"),
      brand_color_background: row.get("brand_color_background"),
      default_paper_size: row.get("default_paper_size"),
      default_locale: row.get("default_locale"),
      default_color_profile: row.get("default_color_profile"),
      default_image_quality: row.get("default_image_quality"),
      ligatures_enabled: row.get("ligatures_enabled"),
      default_template_id: row.get("default_template_id"),
      updated_at: row.get("updated_at"),
      updated_by: row.get::<Option<Uuid>, _>("updated_by").unwrap_or_else(Uuid::nil),
    }
  }

  async fn upsert_document_logo_asset(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    variant: &'static str,
    asset: &PdfDocumentBrandLogoAsset,
    actor: Uuid,
  ) -> RepoResult<Uuid> {
    let id: Uuid = sqlx::query_scalar(
      r#"
      INSERT INTO brand_assets (
        scope, workspace_id, slot, variant, quality_class, storage_kind,
        storage_key, public_path, mime, sha256, byte_size, created_by, updated_at
      )
      VALUES (
        'workspace', $1, 'logo', $2, 'print', 'pdf_blob',
        $3, NULL, $4, $5, $6, $7, now()
      )
      ON CONFLICT (workspace_id, slot, variant, quality_class) WHERE scope = 'workspace'
      DO UPDATE SET
        storage_key = EXCLUDED.storage_key,
        mime = EXCLUDED.mime,
        sha256 = EXCLUDED.sha256,
        byte_size = EXCLUDED.byte_size,
        created_by = EXCLUDED.created_by,
        updated_at = now()
      RETURNING id
      "#,
    )
    .bind(workspace_id)
    .bind(variant)
    .bind(&asset.blob_key)
    .bind(&asset.mime)
    .bind(&asset.sha256)
    .bind(asset.byte_size)
    .bind(actor)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(id)
  }

  async fn resolve_color_profile_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    value: Option<&str>,
  ) -> RepoResult<Option<Uuid>> {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
      return Ok(None);
    };

    if let Ok(id) = Uuid::parse_str(raw) {
      let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM pdf_icc_profiles WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_db_err)?;
      return Ok(found);
    }

    let normalized = raw.to_ascii_lowercase();
    let canonical_name = match normalized.as_str() {
      "srgb" | "s_rgb" | "srgb_v4" | "srgb v4 (system)" => Some("sRGB v4 (system)"),
      "cmyk_swop" | "swop" | "artifex cmyk swop (system)" => Some("Artifex CMYK SWOP (system)"),
      "cmyk_fogra39" | "cmyk_postscript" | "postscript" | "artifex postscript cmyk (system)" => {
        Some("Artifex PostScript CMYK (system)")
      }
      _ => None,
    };

    let found: Option<Uuid> = if let Some(name) = canonical_name {
      sqlx::query_scalar("SELECT id FROM pdf_icc_profiles WHERE name = $1")
        .bind(name)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_db_err)?
    } else {
      sqlx::query_scalar("SELECT id FROM pdf_icc_profiles WHERE lower(name) = lower($1)")
        .bind(raw)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_db_err)?
    };
    Ok(found)
  }
  async fn get_in_connection(conn: &mut sqlx::PgConnection, ws: Uuid) -> RepoResult<PdfWorkspaceBrandAsset> {
    let row = sqlx::query(
      r#"
      WITH base AS (
        SELECT $1::uuid AS workspace_id
      ),
      org AS (
        SELECT COALESCE(
          NULLIF(display_name, ''),
          NULLIF(legal_name, ''),
          NULLIF(short_name, '')
        ) AS company_name,
        NULLIF(legal_name, '') AS organization_legal_name
        FROM organization_identity
        WHERE id = TRUE
      ),
      active_theme AS (
        SELECT tp.theme_id
        FROM theme_profiles tp
        WHERE tp.scope = 'workspace'
          AND tp.workspace_id = $1
        UNION ALL
        SELECT tp.theme_id
        FROM theme_profiles tp
        WHERE tp.scope = 'global'
          AND NOT EXISTS (
            SELECT 1
            FROM theme_profiles ws
            WHERE ws.scope = 'workspace'
              AND ws.workspace_id = $1
          )
        LIMIT 1
      ),
      doc AS (
        SELECT base.workspace_id,
               large.storage_key AS logo_large_blob,
               large.sha256 AS logo_large_sha256,
               small.storage_key AS logo_small_blob,
               small.sha256 AS logo_small_sha256,
               dbp.footer_text,
               dbp.legal_text,
               dbp.color_policy,
               dbp.color_palette_key,
               CASE
                 WHEN dbp.color_policy = 'custom' THEN dbp.custom_primary_color
                 ELSE selected_palette.primary_color
               END AS brand_color_primary,
               CASE
                 WHEN dbp.color_policy = 'custom' THEN dbp.custom_accent_color
                 ELSE selected_palette.accent_color
               END AS brand_color_accent,
               CASE
                 WHEN dbp.color_policy = 'custom' THEN COALESCE(dbp.custom_rule_color, dbp.custom_accent_color, dbp.custom_primary_color, default_palette.rule_color)
                 ELSE selected_palette.rule_color
               END AS brand_color_rule,
               COALESCE(selected_palette.text_color, default_palette.text_color) AS brand_color_text,
               COALESCE(selected_palette.background_color, default_palette.background_color) AS brand_color_background,
               dbp.updated_at,
               dbp.updated_by
        FROM base
        JOIN LATERAL (
          SELECT dbp.*
          FROM document_brand_profiles dbp
          WHERE (dbp.scope = 'workspace' AND dbp.workspace_id = $1)
             OR (dbp.scope = 'global' AND NOT EXISTS (
                  SELECT 1
                  FROM document_brand_profiles ws
                  WHERE ws.scope = 'workspace' AND ws.workspace_id = $1
                ))
          ORDER BY CASE WHEN dbp.scope = 'workspace' THEN 0 ELSE 1 END
          LIMIT 1
        ) dbp ON TRUE
        LEFT JOIN brand_assets large ON large.id = dbp.logo_large_asset_id
        LEFT JOIN brand_assets small ON small.id = dbp.logo_small_asset_id
        LEFT JOIN active_theme t ON TRUE
        LEFT JOIN document_theme_color_palettes selected_palette
          ON selected_palette.theme_id = t.theme_id
         AND selected_palette.palette_key = COALESCE(dbp.color_palette_key, 'balanced')
        LEFT JOIN document_theme_color_palettes default_palette
          ON default_palette.theme_id = t.theme_id
         AND default_palette.is_default = TRUE
      ),
      settings AS (
        SELECT base.workspace_id,
               pes.default_template_id,
               pes.default_paper_size,
               pes.default_locale,
               CASE
                 WHEN icc.name = 'Artifex CMYK SWOP (system)' THEN 'CMYK_SWOP'
                 WHEN icc.name = 'Artifex PostScript CMYK (system)' THEN 'CMYK_FOGRA39'
                 WHEN icc.name IS NOT NULL THEN 'sRGB'
                 ELSE NULL
               END AS default_color_profile,
               pes.default_image_quality,
               pes.ligatures_enabled,
               pes.updated_at,
               pes.updated_by
        FROM base
        JOIN LATERAL (
          SELECT pes.*
          FROM pdf_export_settings pes
          WHERE (pes.scope = 'workspace' AND pes.workspace_id = $1)
             OR (pes.scope = 'global' AND NOT EXISTS (
                  SELECT 1
                  FROM pdf_export_settings ws
                  WHERE ws.scope = 'workspace' AND ws.workspace_id = $1
                ))
          ORDER BY CASE WHEN pes.scope = 'workspace' THEN 0 ELSE 1 END
          LIMIT 1
        ) pes ON TRUE
        LEFT JOIN pdf_icc_profiles icc ON icc.id = pes.default_color_profile_id
      )
      SELECT base.workspace_id,
             doc.logo_large_blob,
             doc.logo_large_sha256,
             doc.logo_small_blob,
             doc.logo_small_sha256,
             org.company_name,
             COALESCE(doc.legal_text, org.organization_legal_name) AS legal_text,
             doc.footer_text,
             COALESCE(doc.color_policy, 'theme_palette') AS color_policy,
             CASE
               WHEN doc.color_policy = 'custom' THEN NULL
               ELSE COALESCE(doc.color_palette_key, 'balanced')
             END AS color_palette_key,
             doc.brand_color_primary,
             doc.brand_color_accent,
             doc.brand_color_rule,
             doc.brand_color_text,
             doc.brand_color_background,
             settings.default_paper_size,
             settings.default_locale,
             settings.default_color_profile,
             settings.default_image_quality,
             COALESCE(settings.ligatures_enabled, TRUE) AS ligatures_enabled,
             settings.default_template_id,
             COALESCE(settings.updated_at, doc.updated_at, now()) AS updated_at,
             COALESCE(settings.updated_by, doc.updated_by) AS updated_by
      FROM base
      LEFT JOIN doc ON doc.workspace_id = base.workspace_id
      LEFT JOIN settings ON settings.workspace_id = base.workspace_id
      LEFT JOIN org ON TRUE
      "#,
    )
    .bind(ws)
    .fetch_one(&mut *conn)
    .await
    .map_err(Self::map_db_err)?;

    Ok(Self::map_row(row))
  }

  /// Creating a workspace override must preserve the untouched inherited fields.
  async fn ensure_document_profile(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ws: Uuid,
    updated_by: Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
  ) -> RepoResult<()> {
    sqlx::query("INSERT INTO document_brand_profiles (scope, workspace_id, logo_large_asset_id, logo_small_asset_id, footer_text, legal_text, color_policy, color_palette_key, custom_primary_color, custom_accent_color, custom_rule_color, updated_at, updated_by) SELECT 'workspace', $1, g.logo_large_asset_id, g.logo_small_asset_id, g.footer_text, g.legal_text, COALESCE(g.color_policy, 'theme_palette'), CASE WHEN g.color_policy = 'custom' THEN NULL ELSE COALESCE(g.color_palette_key, 'balanced') END, g.custom_primary_color, g.custom_accent_color, g.custom_rule_color, $2, $3 FROM (SELECT 1) base LEFT JOIN document_brand_profiles g ON g.scope = 'global' ON CONFLICT (workspace_id) WHERE scope = 'workspace' DO NOTHING")
      .bind(ws).bind(updated_at).bind(updated_by).execute(&mut **tx).await.map_err(Self::map_db_err)?;
    Ok(())
  }

  async fn palette_exists_in_connection(
    conn: &mut sqlx::PgConnection,
    ws: Uuid,
    palette_key: &str,
  ) -> RepoResult<bool> {
    sqlx::query_scalar(
      r#"
      WITH workspace_profile AS (
        SELECT tp.theme_id
        FROM theme_profiles tp
        WHERE tp.scope = 'workspace' AND tp.workspace_id = $1
        LIMIT 1
      ),
      effective_profile AS (
        SELECT theme_id FROM workspace_profile
        UNION ALL
        SELECT tp.theme_id
        FROM theme_profiles tp
        WHERE tp.scope = 'global' AND NOT EXISTS (SELECT 1 FROM workspace_profile)
        LIMIT 1
      )
      SELECT EXISTS (
        SELECT 1 FROM effective_profile ep
        JOIN document_theme_color_palettes p ON p.theme_id = ep.theme_id
        WHERE p.palette_key = $2
      )
      "#,
    )
    .bind(ws)
    .bind(palette_key)
    .fetch_one(&mut *conn)
    .await
    .map_err(Self::map_db_err)
  }
}

/// Serialize workspace mutations, including absent owner rows. Shared global
/// fallback rows/assets remain stable while before/after projections are read.
pub(crate) async fn lock_pdf_workspace(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, ws: Uuid) -> RepoResult<()> {
  let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE")
    .bind(ws)
    .fetch_optional(&mut **tx)
    .await
    .map_err(PgPdfWorkspaceBrandAssetRepository::map_db_err)?;
  if found.is_none() {
    return Err(RepositoryError::NotFound("workspace"));
  }
  sqlx::query(
    "SELECT id FROM document_brand_profiles WHERE scope = 'global' OR workspace_id = $1 ORDER BY id FOR SHARE",
  )
  .bind(ws)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgPdfWorkspaceBrandAssetRepository::map_db_err)?;
  sqlx::query("SELECT id FROM pdf_export_settings WHERE scope = 'global' OR workspace_id = $1 ORDER BY id FOR SHARE")
    .bind(ws)
    .fetch_all(&mut **tx)
    .await
    .map_err(PgPdfWorkspaceBrandAssetRepository::map_db_err)?;
  sqlx::query(
    "SELECT theme_id FROM theme_profiles WHERE scope = 'global' OR workspace_id = $1 ORDER BY theme_id FOR SHARE",
  )
  .bind(ws)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgPdfWorkspaceBrandAssetRepository::map_db_err)?;
  sqlx::query("SELECT theme_id, palette_key FROM document_theme_color_palettes WHERE theme_id IN (SELECT theme_id FROM theme_profiles WHERE scope = 'global' OR workspace_id = $1) ORDER BY theme_id, palette_key FOR SHARE")
    .bind(ws).fetch_all(&mut **tx).await.map_err(PgPdfWorkspaceBrandAssetRepository::map_db_err)?;
  sqlx::query("SELECT id FROM brand_assets WHERE id IN (SELECT logo_large_asset_id FROM document_brand_profiles WHERE scope = 'global' OR workspace_id = $1 UNION SELECT logo_small_asset_id FROM document_brand_profiles WHERE scope = 'global' OR workspace_id = $1) ORDER BY id FOR SHARE")
    .bind(ws).fetch_all(&mut **tx).await.map_err(PgPdfWorkspaceBrandAssetRepository::map_db_err)?;
  Ok(())
}

pub(crate) async fn record_pdf_workspace_audit(
  tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
  ws: Uuid,
  actor: Option<AuditActor>,
  key: &str,
  old: Option<Value>,
  new: Option<Value>,
) -> RepoResult<()> {
  if let Some(actor) = actor {
    PgAuditLogStore::record_in_tx(
      &mut **tx,
      &AuditEvent::mutation(
        key,
        AuditCategory::PdfExportConfig,
        Some(AuditTarget::entity("workspace", ws, None)),
        actor,
        old,
        new,
      ),
    )
    .await
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
  }
  Ok(())
}

fn branding_snapshot(brand: &PdfWorkspaceBrandAsset) -> Value {
  json!({"workspaceId":brand.workspace_id.to_string(), "footerText":brand.footer_text,
    "primary":brand.brand_color_primary, "accent":brand.brand_color_accent, "rule":brand.brand_color_rule,
    "policy":brand.color_policy, "paletteKey":brand.color_palette_key,
    "logoLargeBlob":brand.logo_large_blob, "logoSmallBlob":brand.logo_small_blob})
}

fn settings_snapshot(brand: &PdfWorkspaceBrandAsset) -> Value {
  json!({"workspaceId":brand.workspace_id.to_string(), "paperSize":brand.default_paper_size,
    "locale":brand.default_locale, "colorProfile":brand.default_color_profile,
    "imageQuality":brand.default_image_quality, "ligaturesEnabled":brand.ligatures_enabled,
    "templateId":brand.default_template_id})
}

#[async_trait]
impl PdfWorkspaceBrandAssetRepository for PgPdfWorkspaceBrandAssetRepository {
  #[instrument(skip(self), err)]
  async fn get(&self, ws: Uuid) -> RepoResult<Option<PdfWorkspaceBrandAsset>> {
    let mut conn = self.pool.acquire().await.map_err(Self::map_db_err)?;
    Ok(Some(Self::get_in_connection(&mut conn, ws).await?))
  }

  #[instrument(skip(self), err)]
  async fn list_document_color_palettes(&self, ws: Uuid) -> RepoResult<Vec<PdfDocumentColorPalette>> {
    let rows = sqlx::query(
      r#"
      WITH workspace_profile AS (
        SELECT tp.theme_id
        FROM theme_profiles tp
        WHERE tp.scope = 'workspace' AND tp.workspace_id = $1
        LIMIT 1
      ),
      effective_profile AS (
        SELECT theme_id FROM workspace_profile
        UNION ALL
        SELECT tp.theme_id
        FROM theme_profiles tp
        WHERE tp.scope = 'global' AND NOT EXISTS (SELECT 1 FROM workspace_profile)
        LIMIT 1
      )
      SELECT t.slug AS theme_slug, t.name AS theme_name, p.palette_key, p.name,
             p.primary_color, p.accent_color, p.rule_color, p.text_color,
             p.background_color, p.is_default
      FROM effective_profile ep
      JOIN themes t ON t.id = ep.theme_id
      JOIN document_theme_color_palettes p ON p.theme_id = ep.theme_id
      ORDER BY p.is_default DESC, p.palette_key ASC
      "#,
    )
    .bind(ws)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| PdfDocumentColorPalette {
          theme_slug: row.get("theme_slug"),
          theme_name: row.get("theme_name"),
          palette_key: row.get("palette_key"),
          name: row.get("name"),
          primary_color: row.get("primary_color"),
          accent_color: row.get("accent_color"),
          rule_color: row.get("rule_color"),
          text_color: row.get("text_color"),
          background_color: row.get("background_color"),
          is_default: row.get("is_default"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self), err)]
  async fn document_color_palette_exists(&self, ws: Uuid, palette_key: &str) -> RepoResult<bool> {
    let mut conn = self.pool.acquire().await.map_err(Self::map_db_err)?;
    Self::palette_exists_in_connection(&mut conn, ws, palette_key).await
  }

  /// Set one document-logo slot without touching footer/legal text or the
  /// document color policy.
  #[instrument(skip_all, fields(workspace_id = %ws), err)]
  async fn set_document_logo_blob(
    &self,
    ws: Uuid,
    slot: PdfDocumentBrandLogoSlot,
    asset: Option<PdfDocumentBrandLogoAsset>,
    updated_by: Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<Option<String>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let before = Self::get_in_connection(&mut tx, ws).await?;
    Self::ensure_document_profile(&mut tx, ws, updated_by, updated_at).await?;

    let (variant, column) = match slot {
      PdfDocumentBrandLogoSlot::Large => ("large", "logo_large_asset_id"),
      PdfDocumentBrandLogoSlot::Small => ("small", "logo_small_asset_id"),
    };
    let asset_id = match asset.as_ref() {
      Some(asset) => {
        if asset.sha256.trim().is_empty() || asset.mime.trim().is_empty() || asset.byte_size < 0 {
          return Err(RepositoryError::Validation(
            "document logo hash, MIME type, and non-negative byte size are required".to_owned(),
          ));
        }
        Some(Self::upsert_document_logo_asset(&mut tx, ws, variant, asset, updated_by).await?)
      }
      None => None,
    };
    let sql = format!(
      r#"
      INSERT INTO document_brand_profiles (
        scope, workspace_id, {column}, color_policy, color_palette_key, updated_at, updated_by
      )
      VALUES ('workspace', $1, $2, 'theme_palette', 'balanced', $3, $4)
      ON CONFLICT (workspace_id) WHERE scope = 'workspace'
      DO UPDATE SET
        {column} = EXCLUDED.{column},
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
      "#
    );
    sqlx::query(&sql)
      .bind(ws)
      .bind(asset_id)
      .bind(updated_at)
      .bind(updated_by)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    let previous = match slot {
      PdfDocumentBrandLogoSlot::Large => before.logo_large_blob.clone(),
      PdfDocumentBrandLogoSlot::Small => before.logo_small_blob.clone(),
    };
    let old_hash = match slot {
      PdfDocumentBrandLogoSlot::Large => before.logo_large_sha256.clone(),
      PdfDocumentBrandLogoSlot::Small => before.logo_small_sha256.clone(),
    };
    let kind = match slot {
      PdfDocumentBrandLogoSlot::Large => "large",
      PdfDocumentBrandLogoSlot::Small => "small",
    };
    let new = asset.as_ref().map(|asset| {
      json!({"workspaceId":ws.to_string(), "kind":kind,
      "format":asset.blob_key.rsplit('.').next(), "blobKey":asset.blob_key,"sha256":asset.sha256})
    });
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      if asset.is_some() {
        "document_branding.upload_logo"
      } else {
        "document_branding.delete_logo"
      },
      Some(json!({"workspaceId":ws.to_string(),"kind":kind,"blobKey":previous,"sha256":old_hash})),
      new,
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(previous)
  }

  /// Set footer text without touching logos or document colors.
  #[instrument(skip_all, fields(workspace_id = %ws), err)]
  async fn set_document_branding_text(
    &self,
    ws: Uuid,
    footer_text: Option<String>,
    updated_by: Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let before = Self::get_in_connection(&mut tx, ws).await?;
    Self::ensure_document_profile(&mut tx, ws, updated_by, updated_at).await?;

    sqlx::query(
      r#"
      INSERT INTO document_brand_profiles (
        scope, workspace_id, footer_text, color_policy, color_palette_key, updated_at, updated_by
      )
      VALUES ('workspace', $1, $2, 'theme_palette', 'balanced', $3, $4)
      ON CONFLICT (workspace_id) WHERE scope = 'workspace'
      DO UPDATE SET
        footer_text = EXCLUDED.footer_text,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
      "#,
    )
    .bind(ws)
    .bind(footer_text)
    .bind(updated_at)
    .bind(updated_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let after = Self::get_in_connection(&mut tx, ws).await?;
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "document_branding.update_text",
      Some(branding_snapshot(&before)),
      Some(branding_snapshot(&after)),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Set the color policy without touching document logos or footer/legal
  /// text. `None/None` clears custom colors and returns to the balanced theme
  /// palette.
  #[instrument(skip_all, fields(workspace_id = %ws), err)]
  async fn set_document_branding_colors(
    &self,
    ws: Uuid,
    primary: Option<String>,
    accent: Option<String>,
    updated_by: Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let before = Self::get_in_connection(&mut tx, ws).await?;
    Self::ensure_document_profile(&mut tx, ws, updated_by, updated_at).await?;

    let is_custom_color = primary.is_some() && accent.is_some();
    let color_policy = if is_custom_color { "custom" } else { "theme_palette" };
    let color_palette_key: Option<&str> = if is_custom_color { None } else { Some("balanced") };
    let custom_primary = if is_custom_color { primary.as_deref() } else { None };
    let custom_accent = if is_custom_color { accent.as_deref() } else { None };
    sqlx::query(
      r#"
      INSERT INTO document_brand_profiles (
        scope, workspace_id, color_policy, color_palette_key,
        custom_primary_color, custom_accent_color, custom_rule_color, updated_at, updated_by
      )
      VALUES ('workspace', $1, $2, $3, lower($4), lower($5), lower($6), $7, $8)
      ON CONFLICT (workspace_id) WHERE scope = 'workspace'
      DO UPDATE SET
        color_policy = EXCLUDED.color_policy,
        color_palette_key = EXCLUDED.color_palette_key,
        custom_primary_color = EXCLUDED.custom_primary_color,
        custom_accent_color = EXCLUDED.custom_accent_color,
        custom_rule_color = EXCLUDED.custom_rule_color,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
      "#,
    )
    .bind(ws)
    .bind(color_policy)
    .bind(color_palette_key)
    .bind(custom_primary)
    .bind(custom_accent)
    .bind(custom_accent)
    .bind(updated_at)
    .bind(updated_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let after = Self::get_in_connection(&mut tx, ws).await?;
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "document_branding.update_colors",
      Some(branding_snapshot(&before)),
      Some(branding_snapshot(&after)),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Select a server-owned document palette. This is intentionally separate
  /// from custom-colour writes so a palette click in the admin UI does not
  /// duplicate theme-derived colours into `custom_*` columns.
  #[instrument(skip_all, fields(workspace_id = %ws), err)]
  async fn set_document_branding_color_policy(
    &self,
    ws: Uuid,
    policy: &str,
    palette_key: &str,
    updated_by: Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let before = Self::get_in_connection(&mut tx, ws).await?;
    Self::ensure_document_profile(&mut tx, ws, updated_by, updated_at).await?;

    if !matches!(policy, "plain" | "theme_palette")
      || (policy == "plain" && palette_key != "plain")
      || (policy == "theme_palette" && palette_key == "plain")
      || !Self::palette_exists_in_connection(&mut tx, ws, palette_key).await?
    {
      return Err(RepositoryError::Validation(
        "document palette is unavailable for the workspace's effective theme".into(),
      ));
    }
    sqlx::query(
      r#"
      INSERT INTO document_brand_profiles (
        scope, workspace_id, color_policy, color_palette_key,
        custom_primary_color, custom_accent_color, custom_rule_color,
        updated_at, updated_by
      )
      VALUES ('workspace', $1, $2, $3, NULL, NULL, NULL, $4, $5)
      ON CONFLICT (workspace_id) WHERE scope = 'workspace'
      DO UPDATE SET
        color_policy = EXCLUDED.color_policy,
        color_palette_key = EXCLUDED.color_palette_key,
        custom_primary_color = NULL,
        custom_accent_color = NULL,
        custom_rule_color = NULL,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
      "#,
    )
    .bind(ws)
    .bind(policy)
    .bind(palette_key)
    .bind(updated_at)
    .bind(updated_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let after = Self::get_in_connection(&mut tx, ws).await?;
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "document_branding.set_color_policy",
      Some(branding_snapshot(&before)),
      Some(branding_snapshot(&after)),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Remove exactly the workspace-owned document-branding owner. The renderer
  /// will fall back to global document branding on the next read; PDF export
  /// settings remain untouched because they live in `pdf_export_settings`.
  #[instrument(skip_all, fields(workspace_id = %ws), err)]
  async fn reset_workspace_document_branding(
    &self,
    ws: Uuid,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<PdfWorkspaceDocumentBrandingReset> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, ws).await?;
    let before = Self::get_in_connection(&mut tx, ws).await?;

    let existing = sqlx::query(
      r#"
      SELECT large.storage_key AS logo_large_blob,
             small.storage_key AS logo_small_blob
      FROM document_brand_profiles dbp
      LEFT JOIN brand_assets large ON large.id = dbp.logo_large_asset_id
      LEFT JOIN brand_assets small ON small.id = dbp.logo_small_asset_id
      WHERE dbp.scope = 'workspace'
        AND dbp.workspace_id = $1
      "#,
    )
    .bind(ws)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let mut removed_logo_blobs = Vec::new();
    if let Some(row) = existing.as_ref() {
      for key in [
        row.get::<Option<String>, _>("logo_large_blob"),
        row.get::<Option<String>, _>("logo_small_blob"),
      ]
      .into_iter()
      .flatten()
      {
        if !removed_logo_blobs.contains(&key) {
          removed_logo_blobs.push(key);
        }
      }
    }

    sqlx::query("DELETE FROM document_brand_profiles WHERE scope = 'workspace' AND workspace_id = $1")
      .bind(ws)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    let removed_assets = sqlx::query(
      r#"
      DELETE FROM brand_assets
      WHERE scope = 'workspace'
        AND workspace_id = $1
        AND slot = 'logo'
        AND quality_class = 'print'
      "#,
    )
    .bind(ws)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let after = Self::get_in_connection(&mut tx, ws).await?;
    let mut old = branding_snapshot(&before);
    old["removedWorkspaceProfile"] = json!(existing.is_some());
    let mut new = branding_snapshot(&after);
    new["inheritsGlobal"] = json!(true);
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "document_branding.reset_workspace",
      Some(old),
      Some(new),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;

    Ok(PdfWorkspaceDocumentBrandingReset {
      removed_profile: existing.is_some(),
      removed_logo_blobs,
      removed_asset_rows: removed_assets.rows_affected(),
    })
  }

  /// Insert or update only the PDF-settings owner. Document branding columns
  /// are preserved; the patch is applied to the locked effective settings.
  #[instrument(skip_all, fields(workspace_id = %patch.workspace_id), err)]
  async fn upsert_pdf_export_settings(
    &self,
    patch: &PdfExportSettingsPatch,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    lock_pdf_workspace(&mut tx, patch.workspace_id).await?;
    let before = Self::get_in_connection(&mut tx, patch.workspace_id).await?;
    let ws = patch.workspace_id;
    let mut asset = before.clone();
    if let Some(value) = patch.default_template_id {
      asset.default_template_id = value;
    }
    if let Some(value) = &patch.default_paper_size {
      asset.default_paper_size = value.clone();
    }
    if let Some(value) = &patch.default_locale {
      asset.default_locale = value.clone();
    }
    if let Some(value) = &patch.default_color_profile {
      asset.default_color_profile = value.clone();
    }
    if let Some(value) = &patch.default_image_quality {
      asset.default_image_quality = value.clone();
    }
    if let Some(value) = patch.ligatures_enabled {
      asset.ligatures_enabled = value;
    }
    asset.updated_by = patch.updated_by;
    asset.updated_at = patch.updated_at;
    if let Some(default) = patch.default_template_id {
      if let Some(tpl) = default.filter(|tpl| Some(*tpl) != before.default_template_id) {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pdf_workspace_template_assignments WHERE workspace_id = $1 AND template_id = $2)")
          .bind(ws).bind(tpl).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
        if !exists {
          return Err(RepositoryError::NotFound("pdf_workspace_template_assignment"));
        }
      }
      sqlx::query("UPDATE pdf_workspace_template_assignments SET is_default = false WHERE workspace_id = $1 AND is_default = true")
        .bind(ws).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      if let Some(tpl) = default {
        sqlx::query("UPDATE pdf_workspace_template_assignments SET is_default = true WHERE workspace_id = $1 AND template_id = $2")
          .bind(ws).bind(tpl).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      }
    }

    let color_profile_id = if patch.default_color_profile.is_some() {
      Self::resolve_color_profile_id(&mut tx, asset.default_color_profile.as_deref()).await?
    } else {
      // An unrelated partial edit must retain the actual ICC reference, not its
      // display-family projection (which can normalize custom profiles to sRGB).
      sqlx::query_scalar("SELECT default_color_profile_id FROM pdf_export_settings WHERE scope = 'global' OR workspace_id = $1 ORDER BY CASE WHEN scope = 'workspace' THEN 0 ELSE 1 END LIMIT 1")
        .bind(ws).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.flatten()
    };
    sqlx::query(
      r#"
      INSERT INTO pdf_export_settings (
        scope, workspace_id, default_template_id, default_paper_size,
        default_locale, default_color_profile_id, default_image_quality,
        ligatures_enabled, updated_at, updated_by
      )
      VALUES ('workspace', $1, $2, $3, $4, $5, lower($6), $7, $8, $9)
      ON CONFLICT (workspace_id) WHERE scope = 'workspace'
      DO UPDATE SET
        default_template_id = EXCLUDED.default_template_id,
        default_paper_size = EXCLUDED.default_paper_size,
        default_locale = EXCLUDED.default_locale,
        default_color_profile_id = EXCLUDED.default_color_profile_id,
        default_image_quality = EXCLUDED.default_image_quality,
        ligatures_enabled = EXCLUDED.ligatures_enabled,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
      "#,
    )
    .bind(asset.workspace_id)
    .bind(asset.default_template_id)
    .bind(&asset.default_paper_size)
    .bind(&asset.default_locale)
    .bind(color_profile_id)
    .bind(&asset.default_image_quality)
    .bind(asset.ligatures_enabled)
    .bind(asset.updated_at)
    .bind(asset.updated_by)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let after = Self::get_in_connection(&mut tx, ws).await?;
    record_pdf_workspace_audit(
      &mut tx,
      ws,
      audit_actor,
      "pdf_export_settings.update",
      Some(settings_snapshot(&before)),
      Some(settings_snapshot(&after)),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;

    Ok(())
  }
}
