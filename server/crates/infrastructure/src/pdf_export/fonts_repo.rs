// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`PdfFontRepository`].
//!
//! Fonts are deduplicated by SHA-256 at the DB level (UNIQUE constraint on
//! `pdf_fonts.sha256`). This repository is the add-on upload flow for operator
//! fonts only. Bundled system fonts are owned by the Theme DB
//! (`font_families`/`font_assets`) and are not listed from `pdf_fonts`.
//! The `set_status` method applies `approved_by` / `approved_at` when the new
//! status is `Approved` or `Rejected`, and clears them when resetting to
//! `Pending`.

use crate::audit::PgAuditLogStore;
use async_trait::async_trait;
use chrono::Utc;
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{PdfFont, PdfFontLicense, PdfFontLicenseStatus};
use myoxus_domain::repositories::{
  PdfApprovedFontAsset, PdfFontRepository, PdfFontStatusAudit, PdfFontUploadAudit, PdfThemeFontAsset, RepoResult,
  RepositoryError,
};

/// PostgreSQL-backed implementation of [`PdfFontRepository`].
#[derive(Debug, Clone)]
pub struct PgPdfFontRepository {
  pool: PgPool,
}

impl PgPdfFontRepository {
  /// Construct from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in pdf font repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("pdf_font"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("font with this sha256 already exists")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> RepoResult<PdfFont> {
    let license_str: String = row.get("license");
    let license: PdfFontLicense = serde_json::from_value(serde_json::Value::String(license_str))
      .map_err(|e| RepositoryError::Storage(format!("invalid font license value: {e}")))?;

    let status_str: String = row.get("license_status");
    let license_status: PdfFontLicenseStatus = serde_json::from_value(serde_json::Value::String(status_str))
      .map_err(|e| RepositoryError::Storage(format!("invalid font license_status value: {e}")))?;

    Ok(PdfFont {
      id: row.get("id"),
      family_name: row.get("family_name"),
      style: row.get("style"),
      weight: row.get("weight"),
      blob_key: row.get("blob_key"),
      sha256: row.get("sha256"),
      license,
      license_status,
      uploaded_by: row.get("uploaded_by"),
      uploaded_at: row.get("uploaded_at"),
      approved_by: row.get("approved_by"),
      approved_at: row.get("approved_at"),
    })
  }
}

async fn record_font_audit(
  conn: &mut sqlx::PgConnection,
  font: &PdfFont,
  key: &str,
  actor: AuditActor,
  old: Option<Value>,
  new: Option<Value>,
) -> RepoResult<()> {
  PgAuditLogStore::record_in_tx(
    conn,
    &AuditEvent::mutation(
      key,
      AuditCategory::PdfExportConfig,
      Some(AuditTarget::entity(
        "pdf_font",
        font.id,
        Some(format!("{} {}", font.family_name, font.style)),
      )),
      actor,
      old,
      new,
    ),
  )
  .await
  .map_err(|err| RepositoryError::Storage(err.to_string()))?;
  Ok(())
}

#[async_trait]
impl PdfFontRepository for PgPdfFontRepository {
  #[instrument(skip(self), err)]
  async fn list(&self, status: Option<PdfFontLicenseStatus>) -> RepoResult<Vec<PdfFont>> {
    let rows = match status {
      None => {
        sqlx::query(
          r#"
          SELECT id, family_name, style, weight, blob_key, sha256, license, license_status,
                 uploaded_by, uploaded_at, approved_by, approved_at
          FROM pdf_fonts
          WHERE uploaded_by IS NOT NULL
          ORDER BY family_name ASC, style ASC
          "#,
        )
        .fetch_all(&self.pool)
        .await
      }
      Some(ref s) => {
        let status_str = serde_json::to_value(s)
          .unwrap()
          .as_str()
          .unwrap_or("pending")
          .to_string();
        sqlx::query(
          r#"
          SELECT id, family_name, style, weight, blob_key, sha256, license, license_status,
                 uploaded_by, uploaded_at, approved_by, approved_at
          FROM pdf_fonts
          WHERE uploaded_by IS NOT NULL AND license_status = $1
          ORDER BY family_name ASC, style ASC
          "#,
        )
        .bind(status_str)
        .fetch_all(&self.pool)
        .await
      }
    }
    .map_err(Self::map_db_err)?;

    rows.into_iter().map(Self::map_row).collect()
  }

  #[instrument(skip(self), err)]
  async fn get(&self, id: Uuid) -> RepoResult<Option<PdfFont>> {
    let row = sqlx::query(
      r#"
      SELECT id, family_name, style, weight, blob_key, sha256, license, license_status,
             uploaded_by, uploaded_at, approved_by, approved_at
      FROM pdf_fonts
      WHERE id = $1 AND uploaded_by IS NOT NULL
      "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_row).transpose()
  }

  #[instrument(skip(self), err)]
  async fn get_by_sha256(&self, sha256: &str) -> RepoResult<Option<PdfFont>> {
    let row = sqlx::query(
      r#"
      SELECT id, family_name, style, weight, blob_key, sha256, license, license_status,
             uploaded_by, uploaded_at, approved_by, approved_at
      FROM pdf_fonts
      WHERE sha256 = $1
      "#,
    )
    .bind(sha256)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(Self::map_row).transpose()
  }

  #[instrument(skip_all, fields(font_id = %font.id), err)]
  async fn create(&self, font: &PdfFont, audit: Option<PdfFontUploadAudit>) -> RepoResult<()> {
    let license_str = serde_json::to_value(&font.license)
      .ok()
      .and_then(|v| v.as_str().map(|s| s.to_owned()))
      .unwrap_or_default();

    let status_str = serde_json::to_value(&font.license_status)
      .ok()
      .and_then(|v| v.as_str().map(|s| s.to_owned()))
      .unwrap_or_else(|| "pending".to_owned());

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let inserted = sqlx::query(
      r#"
      INSERT INTO pdf_fonts (
        id, family_name, style, weight, blob_key, sha256, license, license_status,
        uploaded_by, uploaded_at, approved_by, approved_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *
      "#,
    )
    .bind(font.id)
    .bind(&font.family_name)
    .bind(&font.style)
    .bind(font.weight)
    .bind(&font.blob_key)
    .bind(&font.sha256)
    .bind(license_str)
    .bind(status_str)
    .bind(font.uploaded_by)
    .bind(font.uploaded_at)
    .bind(font.approved_by)
    .bind(font.approved_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let inserted = Self::map_row(inserted)?;
    if let Some(audit) = audit {
      record_font_audit(
        &mut tx,
        &inserted,
        "pdf_font.upload",
        audit.actor,
        None,
        Some(
          json!({"familyName":inserted.family_name,"style":inserted.style,"weight":inserted.weight,
          "sha256":inserted.sha256,"license":inserted.license,
          "licenseDescription":audit.license_description,"licenseUrl":audit.license_url}),
        ),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Return this operation's locked result rather than a later writer's row.
  #[instrument(skip_all, fields(font_id = %id), err)]
  async fn set_status(
    &self,
    id: Uuid,
    status: PdfFontLicenseStatus,
    approver: Option<Uuid>,
    license_override: Option<PdfFontLicense>,
    audit: Option<PdfFontStatusAudit>,
  ) -> RepoResult<PdfFont> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let before = sqlx::query("SELECT * FROM pdf_fonts WHERE id=$1 AND uploaded_by IS NOT NULL FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_row)
      .transpose()?
      .ok_or(RepositoryError::NotFound("pdf_font"))?;
    let action = match status {
      PdfFontLicenseStatus::Approved => "pdf_font.approve",
      PdfFontLicenseStatus::Rejected => "pdf_font.reject",
      PdfFontLicenseStatus::Pending if audit.is_some() => {
        return Err(RepositoryError::Validation(
          "pending reset is not an authenticated PDF font mutation".into(),
        ));
      }
      PdfFontLicenseStatus::Pending => "",
    };
    let status_str = serde_json::to_value(&status).map_err(|err| RepositoryError::Storage(err.to_string()))?;
    let license = license_override
      .map(serde_json::to_value)
      .transpose()
      .map_err(|err| RepositoryError::Storage(err.to_string()))?
      .and_then(|value| value.as_str().map(str::to_owned));
    let (approved_by, approved_at) = match status {
      PdfFontLicenseStatus::Approved | PdfFontLicenseStatus::Rejected => (approver, Some(Utc::now())),
      PdfFontLicenseStatus::Pending => (None, None),
    };
    let after = sqlx::query("UPDATE pdf_fonts SET license_status=$1, approved_by=$2, approved_at=$3, license=COALESCE($4,license) WHERE id=$5 RETURNING *")
      .bind(status_str.as_str()).bind(approved_by).bind(approved_at).bind(license).bind(id)
      .fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
    let after = Self::map_row(after)?;
    if let Some(audit) = audit {
      let mut value = json!({"licenseStatus":after.license_status});
      if let Some(reason) = audit.rejection_reason {
        value["reason"] = json!(reason);
      }
      record_font_audit(
        &mut tx,
        &after,
        action,
        audit.actor,
        Some(json!({"licenseStatus":before.license_status})),
        Some(value),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(after)
  }

  #[instrument(skip_all, fields(font_id = %id), err)]
  async fn delete(&self, id: Uuid, audit_actor: Option<AuditActor>) -> RepoResult<Option<PdfFont>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let before = sqlx::query("SELECT * FROM pdf_fonts WHERE id=$1 AND uploaded_by IS NOT NULL FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_row)
      .transpose()?;
    let Some(before) = before else { return Ok(None) };
    sqlx::query("DELETE FROM pdf_fonts WHERE id=$1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if let Some(actor) = audit_actor {
      record_font_audit(
        &mut tx,
        &before,
        "pdf_font.delete",
        actor,
        Some(
          json!({"familyName":before.family_name,"style":before.style,"weight":before.weight,
          "sha256":before.sha256,"license":before.license,"licenseStatus":before.license_status}),
        ),
        None,
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(Some(before))
  }

  #[instrument(skip(self), err)]
  async fn resolve_theme_font_asset(&self, family_slug: &str) -> RepoResult<Option<PdfThemeFontAsset>> {
    // Family defaults must prefer upright text. Asset-key ordering otherwise
    // selects e.g. inter-italic before inter, slanting every outlined preview.
    let row = sqlx::query(
      r#"
      SELECT ff.slug, ff.display_name, fa.asset_key, fa.sha256, fa.format
      FROM font_families ff
      JOIN font_assets fa ON fa.family_id = ff.id
      WHERE ff.slug = $1
        AND ff.license_status = 'approved'
        AND ff.is_selectable = TRUE
        AND fa.usage = 'pdf'
        AND fa.format IN ('variable_ttf', 'ttf', 'otf')
      ORDER BY
        CASE fa.style WHEN 'normal' THEN 0 ELSE 1 END,
        CASE fa.format
          WHEN 'variable_ttf' THEN 0
          WHEN 'ttf' THEN 1
          WHEN 'otf' THEN 2
          ELSE 3
        END,
        ABS(fa.weight_default - 400),
        fa.asset_key
      LIMIT 1
      "#,
    )
    .bind(family_slug)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| PdfThemeFontAsset {
      family_slug: row.get("slug"),
      family: row.get("display_name"),
      asset_key: row.get("asset_key"),
      sha256: row.get("sha256"),
      format: row.get("format"),
    }))
  }

  #[instrument(skip(self), err)]
  async fn list_approved_render_assets(&self) -> RepoResult<Vec<PdfApprovedFontAsset>> {
    let rows = sqlx::query(
      r#"
      SELECT ff.display_name AS family_name, fa.style, fa.asset_key AS blob_key, fa.sha256, fa.format
      FROM font_families ff
      JOIN font_assets fa ON fa.family_id = ff.id
      WHERE ff.source = 'uploaded'
        AND ff.license_status = 'approved'
        AND ff.is_selectable = TRUE
        AND fa.usage = 'pdf'
        AND fa.format IN ('variable_ttf', 'ttf', 'otf')
      UNION ALL
      SELECT pf.family_name, pf.style, pf.blob_key, pf.sha256,
        CASE WHEN lower(pf.blob_key) LIKE '%.otf' THEN 'otf' ELSE 'ttf' END AS format
      FROM pdf_fonts pf
      WHERE pf.uploaded_by IS NOT NULL
        AND pf.license_status = 'approved'
        AND lower(pf.blob_key) NOT LIKE '%.woff'
        AND lower(pf.blob_key) NOT LIKE '%.woff2'
      ORDER BY family_name ASC, style ASC, blob_key ASC
      "#,
    )
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| PdfApprovedFontAsset {
          family: row.get("family_name"),
          style: row.get("style"),
          blob_key: row.get("blob_key"),
          sha256: row.get("sha256"),
          format: row.get("format"),
        })
        .collect(),
    )
  }
}
