// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL-backed implementation of [`PdfTemplateRepository`].
//!
//! Template mutations and their optional authenticated audit share a transaction.
//! Header/inventory comparisons and partial metadata patches use the row lock;
//! blob ownership and retention remain with the caller.

use crate::audit::PgAuditLogStore;
use async_trait::async_trait;
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use tracing::{error, instrument};
use uuid::Uuid;

use myoxus_domain::entities::{PdfTemplate, PdfTemplateFile};
use myoxus_domain::repositories::{PdfTemplateRepository, RepoResult, RepositoryError};

/// PostgreSQL-backed implementation of [`PdfTemplateRepository`].
#[derive(Debug, Clone)]
pub struct PgPdfTemplateRepository {
  pool: PgPool,
}

impl PgPdfTemplateRepository {
  /// Construct from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "database error in pdf template repository");
    match err {
      sqlx::Error::RowNotFound => RepositoryError::NotFound("pdf_template"),
      sqlx::Error::Database(ref dbe) if dbe.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("pdf_template slug already exists")
      }
      _ => RepositoryError::Storage(err.to_string()),
    }
  }

  fn map_row(row: sqlx::postgres::PgRow) -> PdfTemplate {
    PdfTemplate {
      id: row.get("id"),
      slug: row.get("slug"),
      name: row.get("name"),
      version: row.get("version"),
      schema_version: row.get("schema_version"),
      manifest: row.get("manifest"),
      created_by: row.get("created_by"),
      created_at: row.get("created_at"),
      deleted_at: row.get("deleted_at"),
    }
  }
}

#[async_trait]
impl PdfTemplateRepository for PgPdfTemplateRepository {
  #[instrument(skip(self), err)]
  async fn list(&self, include_deleted: bool) -> RepoResult<Vec<PdfTemplate>> {
    let rows = if include_deleted {
      sqlx::query(
        r#"
        SELECT id, slug, name, version, schema_version, manifest, created_by, created_at, deleted_at
        FROM pdf_templates
        ORDER BY created_at DESC
        "#,
      )
      .fetch_all(&self.pool)
      .await
    } else {
      sqlx::query(
        r#"
        SELECT id, slug, name, version, schema_version, manifest, created_by, created_at, deleted_at
        FROM pdf_templates
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        "#,
      )
      .fetch_all(&self.pool)
      .await
    }
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_row).collect())
  }

  #[instrument(skip(self), err)]
  async fn get_by_id(&self, id: Uuid) -> RepoResult<Option<PdfTemplate>> {
    let row = sqlx::query(
      r#"
      SELECT id, slug, name, version, schema_version, manifest, created_by, created_at, deleted_at
      FROM pdf_templates
      WHERE id = $1
      "#,
    )
    .bind(id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(Self::map_row))
  }

  #[instrument(skip(self), err)]
  async fn get_by_slug(&self, slug: &str) -> RepoResult<Option<PdfTemplate>> {
    let row = sqlx::query(
      r#"
      SELECT id, slug, name, version, schema_version, manifest, created_by, created_at, deleted_at
      FROM pdf_templates
      WHERE slug = $1 AND deleted_at IS NULL
      "#,
    )
    .bind(slug)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(Self::map_row))
  }

  #[instrument(skip_all, fields(template_id=%tpl.id), err)]
  async fn create(
    &self,
    tpl: &PdfTemplate,
    files: &[PdfTemplateFile],
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;

    sqlx::query(
      r#"
      INSERT INTO pdf_templates (id, slug, name, version, schema_version, manifest, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      "#,
    )
    .bind(tpl.id)
    .bind(&tpl.slug)
    .bind(&tpl.name)
    .bind(&tpl.version)
    .bind(&tpl.schema_version)
    .bind(&tpl.manifest)
    .bind(tpl.created_by)
    .bind(tpl.created_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    for file in files {
      sqlx::query(
        r#"
        INSERT INTO pdf_template_files (template_id, file_path, blob_key, content_hash)
        VALUES ($1, $2, $3, $4)
        "#,
      )
      .bind(file.template_id)
      .bind(&file.file_path)
      .bind(&file.blob_key)
      .bind(&file.content_hash)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    if let Some(actor) = audit_actor {
      record_template_audit(
        &mut tx,
        tpl,
        "pdf_template.upload",
        actor,
        None,
        Some(bundle_audit_value(tpl, files.len())),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self), err)]
  async fn list_files(&self, id: Uuid) -> RepoResult<Vec<PdfTemplateFile>> {
    let rows = sqlx::query(
      r#"
      SELECT template_id, file_path, blob_key, content_hash
      FROM pdf_template_files
      WHERE template_id = $1
      ORDER BY file_path
      "#,
    )
    .bind(id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(
      rows
        .into_iter()
        .map(|row| PdfTemplateFile {
          template_id: row.get("template_id"),
          file_path: row.get("file_path"),
          blob_key: row.get("blob_key"),
          content_hash: row.get("content_hash"),
        })
        .collect(),
    )
  }

  #[instrument(skip_all, fields(template_id=%tpl.id), err)]
  async fn replace_bundle(
    &self,
    tpl: &PdfTemplate,
    files: &[PdfTemplateFile],
    expected: &PdfTemplate,
    expected_files: &[PdfTemplateFile],
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = sqlx::query("SELECT * FROM pdf_templates WHERE id = $1 FOR UPDATE")
      .bind(tpl.id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_row)
      .ok_or(RepositoryError::Conflict("PDF bundle was removed"))?;
    let rows = sqlx::query(
      "SELECT file_path, blob_key, content_hash FROM pdf_template_files WHERE template_id = $1 ORDER BY file_path",
    )
    .bind(tpl.id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let observed_files: std::collections::BTreeMap<_, _> = expected_files
      .iter()
      .map(|f| (f.file_path.as_str(), (f.blob_key.as_str(), f.content_hash.as_str())))
      .collect();
    let matches = rows.len() == observed_files.len()
      && rows.iter().all(|r| {
        observed_files.get(r.get::<&str, _>("file_path"))
          == Some(&(r.get::<&str, _>("blob_key"), r.get::<&str, _>("content_hash")))
      });
    if current.id != expected.id
      || current.slug != expected.slug
      || current.name != expected.name
      || current.version != expected.version
      || current.schema_version != expected.schema_version
      || current.created_by != expected.created_by
      || current.deleted_at != expected.deleted_at
      || current.manifest != expected.manifest
      || !matches
    {
      return Err(RepositoryError::Conflict("PDF bundle changed after it was observed"));
    }
    let result = sqlx::query(
      r#"
      UPDATE pdf_templates
         SET name = $1,
             version = $2,
             schema_version = $3,
             manifest = $4
       WHERE id = $5 AND deleted_at IS NULL AND version = $6
      "#,
    )
    .bind(&tpl.name)
    .bind(&tpl.version)
    .bind(&tpl.schema_version)
    .bind(&tpl.manifest)
    .bind(tpl.id)
    .bind(&expected.version)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(RepositoryError::Conflict(
        "pdf_template changed while its bundle was being replaced",
      ));
    }

    sqlx::query("DELETE FROM pdf_template_files WHERE template_id = $1")
      .bind(tpl.id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    for file in files {
      sqlx::query(
        r#"
        INSERT INTO pdf_template_files (template_id, file_path, blob_key, content_hash)
        VALUES ($1, $2, $3, $4)
        "#,
      )
      .bind(file.template_id)
      .bind(&file.file_path)
      .bind(&file.blob_key)
      .bind(&file.content_hash)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    if let Some(actor) = audit_actor {
      record_template_audit(
        &mut tx,
        tpl,
        "pdf_template.replace_bundle",
        actor,
        Some(json!({"templateId":current.id.to_string(),"slug":current.slug,"version":current.version})),
        Some(bundle_audit_value(tpl, files.len())),
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self, manifest), err)]
  async fn update_manifest(&self, id: Uuid, manifest: &serde_json::Value) -> RepoResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE pdf_templates SET manifest = $1 WHERE id = $2 AND deleted_at IS NULL
      "#,
    )
    .bind(manifest)
    .bind(id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() == 0 {
      return Err(RepositoryError::NotFound("pdf_template"));
    }
    Ok(())
  }

  #[instrument(skip_all,fields(template_id=%id),err)]
  async fn update_metadata(
    &self,
    id: Uuid,
    name: Option<&str>,
    description: Option<&str>,
    audit_actor: Option<AuditActor>,
  ) -> RepoResult<PdfTemplate> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let before = sqlx::query("SELECT * FROM pdf_templates WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_row)
      .ok_or(RepositoryError::NotFound("pdf_template"))?;
    if before.deleted_at.is_some() {
      return Err(RepositoryError::Validation(
        "cannot edit a soft-deleted template — restore it first".into(),
      ));
    }
    let mut after = before.clone();
    if let Some(name) = name {
      after.name = name.to_owned();
      if let Some(object) = after.manifest.as_object_mut() {
        object.insert("name".into(), json!(name));
      }
    }
    if let Some(description) = description {
      if let Some(object) = after.manifest.as_object_mut() {
        object.insert("description".into(), json!(description));
      }
    }
    sqlx::query("UPDATE pdf_templates SET name=$1,manifest=$2 WHERE id=$3")
      .bind(&after.name)
      .bind(&after.manifest)
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if let Some(actor) = audit_actor {
      record_template_audit(&mut tx,&after,"pdf_template.update_metadata",actor,
        Some(json!({"templateId":id.to_string(),"slug":before.slug,"name":before.name,"description":before.manifest.get("description")})),
        Some(json!({"templateId":id.to_string(),"slug":after.slug,"name":after.name,"description":after.manifest.get("description"),"nameUpdated":name.is_some(),"descriptionUpdated":description.is_some()}))).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(after)
  }

  #[instrument(skip_all,fields(template_id=%id),err)]
  async fn soft_delete(&self, id: Uuid, audit_actor: Option<AuditActor>) -> RepoResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let before = sqlx::query("SELECT * FROM pdf_templates WHERE id=$1 FOR UPDATE")
      .bind(id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .map(Self::map_row);
    let Some(before) = before else { return Ok(false) };
    if before.deleted_at.is_some() {
      return Ok(false);
    };
    // Assignment admission takes a shared template lock, so a new assignment
    // cannot enter between this protected check and the committed deletion.
    let assignments: i64 =
      sqlx::query_scalar("SELECT count(*) FROM pdf_workspace_template_assignments WHERE template_id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if assignments > 0 {
      return Err(RepositoryError::Validation(format!(
        "cannot delete template — {assignments} workspace assignment(s) still reference it; un-assign first"
      )));
    }
    sqlx::query("UPDATE pdf_templates SET deleted_at=now() WHERE id=$1")
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if let Some(actor) = audit_actor {
      record_template_audit(
        &mut tx,
        &before,
        "pdf_template.delete",
        actor,
        Some(json!({"templateId":id.to_string(),"slug":before.slug})),
        None,
      )
      .await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(true)
  }
}

fn bundle_audit_value(template: &PdfTemplate, file_count: usize) -> Value {
  json!({"templateId":template.id.to_string(),"slug":template.slug,"name":template.name,"version":template.version,
    "licenseSpdx":template.manifest.pointer("/provenance/license_spdx"),"sourceUrl":template.manifest.pointer("/provenance/source_url"),
    "rightsConfirmed":true,"fileCount":file_count})
}

async fn record_template_audit(
  conn: &mut sqlx::PgConnection,
  template: &PdfTemplate,
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
        "pdf_template",
        template.id,
        Some(template.slug.clone()),
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

/// Fetch all file records for a given template.
///
/// This is a helper used by tests and higher-level services to verify that
/// all manifest-declared files were persisted together with their template.
pub async fn list_files_for_template(pool: &PgPool, template_id: Uuid) -> RepoResult<Vec<PdfTemplateFile>> {
  PgPdfTemplateRepository::new(pool.clone()).list_files(template_id).await
}
