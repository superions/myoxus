// SPDX-License-Identifier: AGPL-3.0-or-later
//! Conservative repair for persisted template source attribution.

use anyhow::{Context, bail};
use clap::Args;
use serde::Serialize;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use tabled::Tabled;
use tracing::instrument;
use uuid::Uuid;

use crate::output::print_output;

const MAX_REPAIR_ROWS: u32 = 1_000;

#[derive(Args, Debug)]
pub struct TemplateRepairArgs {
  /// Restrict inspection to one workspace.
  #[arg(long)]
  pub workspace_id: Option<Uuid>,
  /// Continue strictly after this instance UUID.
  #[arg(long)]
  pub after: Option<Uuid>,
  /// Maximum number of instance rows to inspect.
  #[arg(long, default_value_t = 100)]
  pub limit: u32,
  /// Commit unambiguous repairs. Without this flag the command is read-only.
  #[arg(long)]
  pub apply: bool,
}

#[derive(Debug, FromRow)]
struct InstanceRow {
  instance_id: Uuid,
  workspace_id: Uuid,
  template_id: Uuid,
  revision_id: Option<Uuid>,
  workspace_doc_id: Option<Uuid>,
  workspace_doc_key: Option<String>,
  category: Option<String>,
}

#[derive(Debug, FromRow)]
struct DocRow {
  id: Uuid,
  workspace_id: Uuid,
  external_id: String,
  deleted: bool,
}

#[derive(Debug, FromRow)]
struct StateRow {
  state: String,
  template_id: Option<Uuid>,
  revision_id: Option<Uuid>,
  instance_id: Option<Uuid>,
}

#[derive(Debug, Serialize, Tabled)]
pub struct TemplateRepairRow {
  instance_id: String,
  workspace_id: String,
  template_id: String,
  document_id: String,
  document_key: String,
  outcome: String,
  detail: String,
}

#[instrument(skip(pool), fields(apply = args.apply, limit = args.limit))]
pub async fn run(args: TemplateRepairArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  if args.limit == 0 || args.limit > MAX_REPAIR_ROWS {
    bail!("limit must be between 1 and {MAX_REPAIR_ROWS}");
  }

  let mut tx = pool.begin().await.context("start template attribution repair")?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
    .execute(&mut *tx)
    .await
    .context("isolate template attribution repair")?;
  let instances = sqlx::query_as::<_, InstanceRow>(
    r#"
    SELECT i.id AS instance_id, i.workspace_id, i.template_id, i.revision_id,
           i.workspace_doc_id, i.workspace_doc_key, c.category
    FROM workspace_template_instances i
    JOIN template_catalog_entries c ON c.id = i.template_id
    WHERE ($1::uuid IS NULL OR i.workspace_id = $1)
      AND ($2::uuid IS NULL OR i.id > $2)
    ORDER BY i.id
    LIMIT $3
    FOR UPDATE OF i
    "#,
  )
  .bind(args.workspace_id)
  .bind(args.after)
  .bind(i64::from(args.limit))
  .fetch_all(&mut *tx)
  .await
  .context("scan template instances")?;

  let mut output = Vec::with_capacity(instances.len());
  for instance in instances {
    output.push(inspect_instance(&mut tx, &instance, args.apply).await?);
  }

  if args.apply {
    tx.commit().await.context("commit template attribution repair")?;
  } else {
    tx.rollback().await.context("finish template attribution dry-run")?;
  }
  print_output(&output, json);
  Ok(())
}

async fn inspect_instance(
  tx: &mut Transaction<'_, Postgres>,
  instance: &InstanceRow,
  apply: bool,
) -> anyhow::Result<TemplateRepairRow> {
  let internal_doc = match instance.workspace_doc_id {
    Some(doc_id) => load_doc(tx, doc_id).await?,
    None => None,
  };
  let keyed_docs = match instance.workspace_doc_key.as_deref() {
    Some(key) => sqlx::query_as::<_, DocRow>(
      "SELECT id, workspace_id, external_id, deleted_at IS NOT NULL AS deleted FROM docs WHERE workspace_id = $1 AND external_id = $2 ORDER BY id",
    )
    .bind(instance.workspace_id)
    .bind(key)
    .fetch_all(&mut **tx)
    .await
    .context("resolve workspace document key")?,
    None => Vec::new(),
  };

  let resolved = match (&internal_doc, keyed_docs.as_slice()) {
    (Some(doc), _) if doc.workspace_id != instance.workspace_id => {
      return Ok(report(
        instance,
        None,
        "ambiguous",
        "internal document belongs to another workspace",
      ));
    }
    (Some(doc), [keyed]) if keyed.id != doc.id => {
      return Ok(report(
        instance,
        Some(doc),
        "ambiguous",
        "internal and external document identities disagree",
      ));
    }
    (Some(doc), many) if many.len() > 1 => {
      return Ok(report(
        instance,
        Some(doc),
        "ambiguous",
        "external key resolves to multiple documents",
      ));
    }
    (Some(doc), _) => doc,
    (None, [doc]) => doc,
    (None, []) => {
      return Ok(report(
        instance,
        None,
        "unresolved",
        "no document resolves from the persisted binding",
      ));
    }
    (None, _) => {
      return Ok(report(
        instance,
        None,
        "ambiguous",
        "external key resolves to multiple documents",
      ));
    }
  };

  if resolved.deleted {
    return Ok(report(
      instance,
      Some(resolved),
      "preserved",
      "source is trashed; no attribution was changed",
    ));
  }

  let competing: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*) FROM workspace_template_instances
    WHERE id <> $1 AND workspace_id = $2
      AND (workspace_doc_id = $3 OR workspace_doc_key = $4)
    "#,
  )
  .bind(instance.instance_id)
  .bind(instance.workspace_id)
  .bind(resolved.id)
  .bind(&resolved.external_id)
  .fetch_one(&mut **tx)
  .await
  .context("check duplicate template source bindings")?;
  if competing > 0 {
    return Ok(report(
      instance,
      Some(resolved),
      "ambiguous",
      "another Registry instance references the same document",
    ));
  }

  let state = sqlx::query_as::<_, StateRow>(
    "SELECT state, template_id, revision_id, instance_id FROM document_template_state WHERE doc_id = $1",
  )
  .bind(resolved.id)
  .fetch_optional(&mut **tx)
  .await
  .context("load native template attribution")?;

  let mut actions = Vec::new();
  let mut unresolved_detail = None;
  if instance.workspace_doc_id != Some(resolved.id)
    || instance.workspace_doc_key.as_deref() != Some(&resolved.external_id)
  {
    actions.push("binding");
  }

  if instance.category.as_deref() == Some("onboarding") {
    if let Some(state) = &state {
      if state.template_id == Some(instance.template_id) && state.instance_id == Some(instance.instance_id) {
        actions.push("onboarding-state");
      } else {
        return Ok(report(
          instance,
          Some(resolved),
          "ambiguous",
          "onboarding template state lacks matching Registry provenance",
        ));
      }
    }
  } else if let Some(state) = &state {
    if state.state == "none"
      || state.template_id.is_some_and(|id| id != instance.template_id)
      || state.revision_id.is_some() && state.revision_id != instance.revision_id
      || state.instance_id.is_some_and(|id| id != instance.instance_id)
    {
      return Ok(report(
        instance,
        Some(resolved),
        "ambiguous",
        "native attribution conflicts with the Registry binding",
      ));
    }
    if state.template_id.is_none()
      || instance.revision_id.is_some() && state.revision_id.is_none()
      || state.instance_id.is_none()
    {
      actions.push("native-attribution");
    }
  } else {
    unresolved_detail = Some("native template state is absent; explicit unmarking cannot be excluded");
  }

  if actions.is_empty() {
    if let Some(detail) = unresolved_detail {
      return Ok(report(instance, Some(resolved), "ambiguous", detail));
    }
    return Ok(report(
      instance,
      Some(resolved),
      "unchanged",
      "binding and attribution are already consistent",
    ));
  }
  if apply {
    if actions.contains(&"binding") {
      sqlx::query(
        "UPDATE workspace_template_instances SET workspace_doc_id = $2, workspace_doc_key = $3, updated_at = now() WHERE id = $1",
      )
      .bind(instance.instance_id)
      .bind(resolved.id)
      .bind(&resolved.external_id)
      .execute(&mut **tx)
      .await
      .context("repair Registry document binding")?;
    }
    if actions.contains(&"onboarding-state") {
      sqlx::query("DELETE FROM document_template_state WHERE doc_id = $1")
        .bind(resolved.id)
        .execute(&mut **tx)
        .await
        .context("remove proven onboarding misclassification")?;
    } else if actions.contains(&"native-attribution") {
      sqlx::query(
        r#"
        UPDATE document_template_state
        SET template_id = COALESCE(template_id, $2),
            revision_id = COALESCE(revision_id, $3),
            instance_id = COALESCE(instance_id, $4), updated_at = now()
        WHERE doc_id = $1
        "#,
      )
      .bind(resolved.id)
      .bind(instance.template_id)
      .bind(instance.revision_id)
      .bind(instance.instance_id)
      .execute(&mut **tx)
      .await
      .context("repair native template attribution")?;
    }
  }

  let detail = match unresolved_detail {
    Some(unresolved) => format!("{}; {unresolved}", actions.join(",")),
    None => actions.join(","),
  };
  Ok(report(
    instance,
    Some(resolved),
    match (apply, unresolved_detail.is_some()) {
      (true, true) => "repaired-partial",
      (false, true) => "would-repair-partial",
      (true, false) => "repaired",
      (false, false) => "would-repair",
    },
    &detail,
  ))
}

async fn load_doc(tx: &mut Transaction<'_, Postgres>, doc_id: Uuid) -> anyhow::Result<Option<DocRow>> {
  sqlx::query_as::<_, DocRow>(
    "SELECT id, workspace_id, external_id, deleted_at IS NOT NULL AS deleted FROM docs WHERE id = $1",
  )
  .bind(doc_id)
  .fetch_optional(&mut **tx)
  .await
  .context("load bound template document")
}

fn report(instance: &InstanceRow, doc: Option<&DocRow>, outcome: &str, detail: &str) -> TemplateRepairRow {
  TemplateRepairRow {
    instance_id: instance.instance_id.to_string(),
    workspace_id: instance.workspace_id.to_string(),
    template_id: instance.template_id.to_string(),
    document_id: doc.map(|value| value.id.to_string()).unwrap_or_default(),
    document_key: doc
      .map(|value| value.external_id.clone())
      .or_else(|| instance.workspace_doc_key.clone())
      .unwrap_or_default(),
    outcome: outcome.to_string(),
    detail: detail.to_string(),
  }
}
