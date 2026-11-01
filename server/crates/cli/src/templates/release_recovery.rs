// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit recovery after an operator confirms that system sources may be replaced.

use std::{
  collections::{BTreeMap, BTreeSet},
  io::Write,
};

use anyhow::{Context, bail, ensure};
use clap::Args;
use myoxus_application::{
  doc::{PermanentDeleteMode, PermanentDeleteRequest},
  template_registry::{
    ReleasedBuiltinAdoption, attest_shipped_revision,
    bundle::{self, ParsedBundle},
    released_system_baseline_version,
  },
};
use myoxus_domain::{
  feature_bundle::FeatureComponentKind,
  template_registry::{ProvisioningMode, SelectionMode},
};
use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;
use serde::Serialize;
use sqlx::{FromRow, PgConnection, PgPool};
use tabled::Tabled;
use tracing::{info, instrument};
use uuid::Uuid;

use crate::{output::print_output, services::Services};

#[derive(Args, Debug, Clone)]
pub struct RecoveryArgs {
  #[arg(long, required_unless_present = "all_workspaces", conflicts_with = "all_workspaces")]
  pub workspace_id: Option<Uuid>,
  /// Process active Workspaces in bounded native pages, recalculating on replay.
  #[arg(long)]
  pub all_workspaces: bool,
  /// SLUG=EXTERNAL_KEY for an old source whose Registry binding was lost.
  #[arg(long = "orphan-source", requires = "workspace_id", conflicts_with = "all_workspaces")]
  pub orphan_sources: Vec<String>,
  /// SLUG=EXTERNAL_KEY for a selected unknown bound or detached system source.
  #[arg(
    long = "unknown-source",
    requires = "workspace_id",
    conflicts_with = "all_workspaces"
  )]
  pub unknown_sources: Vec<String>,
  /// Withdrawn system slugs absent from the admitted release, never custom templates.
  #[arg(long = "retire-slug")]
  pub retired_slugs: Vec<String>,
  /// Confirm that selected system sources/publications have no customizations to retain.
  #[arg(long, conflicts_with = "all_workspaces")]
  pub confirm_unmodified_system_documents: bool,
  /// Apply the displayed recovery. Without this flag all inspection is read-only.
  #[arg(long)]
  pub apply: bool,
}

#[derive(Default)]
struct ReleaseSource {
  version: Option<String>,
  default: bool,
  guide: bool,
  revisions: BTreeMap<String, ParsedBundle>,
}

impl ReleaseSource {
  fn baseline(&self, slug: &str) -> Option<&ParsedBundle> {
    released_system_baseline_version(slug).and_then(|version| self.revisions.get(version))
  }
}

#[derive(FromRow)]
struct Catalog {
  id: Uuid,
  slug: String,
  source: String,
  status: String,
  operator_current: bool,
}

#[derive(Clone, FromRow)]
struct Assignment {
  id: Uuid,
  template_id: Uuid,
  selection_mode: String,
  provisioning_mode: String,
  is_enabled: bool,
  state: Option<String>,
  version: Option<String>,
  document_key: Option<String>,
  document_exists: bool,
  has_revision: bool,
  guide_copy: bool,
  native_source: bool,
  preserved_source: bool,
  document_id: Option<Uuid>,
  locale: Option<String>,
}

#[derive(Debug, Serialize, Tabled)]
struct RecoveryRow {
  workspace: String,
  scope: String,
  source: String,
  target_version: String,
  operation: String,
}

/// Stream one JSON array instead of retaining every Workspace plan in memory.
struct RecoveryOutput {
  json: bool,
  written: bool,
}
impl RecoveryOutput {
  fn rows(&mut self, workspace: Option<Uuid>, rows: &mut [RecoveryRow]) -> anyhow::Result<()> {
    if rows.is_empty() {
      return Ok(());
    }
    for row in rows.iter_mut() {
      row.workspace = workspace.map(|id| id.to_string()).unwrap_or_default();
    }
    if !self.json {
      print_output(rows, false);
      return Ok(());
    }
    let mut stdout = std::io::stdout().lock();
    if !self.written {
      stdout.write_all(b"[")?;
    }
    for row in rows {
      if self.written {
        stdout.write_all(b",\n")?;
      }
      serde_json::to_writer(&mut stdout, row)?;
      self.written = true;
    }
    Ok(())
  }
  fn finish(&mut self) -> anyhow::Result<()> {
    if self.json {
      let mut stdout = std::io::stdout().lock();
      stdout.write_all(if self.written { b"]\n" } else { b"[]\n" })?;
    }
    Ok(())
  }
}

struct RecoveryPlan {
  catalog: Vec<Catalog>,
  desired: BTreeSet<Uuid>,
  replacements: Vec<Assignment>,
  replaced_keys: Vec<(Uuid, String)>,
  orphans: BTreeMap<String, String>,
  output: Vec<RecoveryRow>,
  unresolved: usize,
  attested_publications: Vec<Uuid>,
  attested_defaults: Vec<Uuid>,
  source_deletions: Vec<CapturedSourceDeletion>,
}

#[derive(FromRow)]
struct CapturedSourceDeletion {
  document_id: Uuid,
  source_key: String,
  revision: i64,
}

/// Ledger validation and source admission are reads, even when the installed
/// database predates ownership columns or contains historical config aliases.
#[instrument(skip_all, fields(workspace_id = ?args.workspace_id, all_workspaces = args.all_workspaces))]
pub async fn preview(args: RecoveryArgs, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let mut tx = pool.begin().await?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    .execute(&mut *tx)
    .await?;
  let ledger = myoxus_infrastructure::migrations::inspect_connection(&mut tx).await?;
  let highest = ledger
    .highest_applied
    .context("recovery requires a baseline-1000 database")?;
  // Do not validate/migrate unrelated historical app_configs keys here. Only the
  // canonical source-root override is consumed by this read-only operation.
  let root: Option<serde_json::Value> =
    sqlx::query_scalar("SELECT value FROM app_configs WHERE id='templates.root_dir'")
      .fetch_optional(&mut *tx)
      .await?;
  let (_, sources) = Services::capture_feature_sources(root.as_ref())?;
  let columns: (bool, bool) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='template_revisions' AND column_name='release_managed_publication'), EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='template_default_policies' AND column_name='release_managed')")
    .fetch_one(&mut *tx).await?;
  ensure!(
    columns == (highest >= 1047, highest >= 1046),
    "ownership columns do not match the canonical migration ledger"
  );
  let mut output = RecoveryOutput { json, written: false };
  let result: anyhow::Result<()> = async {
    let mut after = None;
    let mut unresolved = 0;
    loop {
      let workspaces = if args.all_workspaces {
        SqlxTemplateRegistryStore::release_workspace_ids_in(&mut tx, after, 100).await?
      } else if after.is_none() {
        vec![args.workspace_id.context("select a Workspace scope")?]
      } else {
        vec![]
      };
      if workspaces.is_empty() {
        break;
      }
      for workspace in workspaces {
        let mut plan = inspect(&args, Some(workspace), &mut tx, &sources).await?;
        unresolved += plan.unresolved;
        output.rows(Some(workspace), &mut plan.output)?;
        after = Some(workspace);
      }
    }
    if after.is_none() {
      let mut plan = inspect(&args, None, &mut tx, &sources).await?;
      unresolved += plan.unresolved;
      output.rows(None, &mut plan.output)?;
    }
    output.rows(
      None,
      &mut [RecoveryRow {
        workspace: String::new(),
        scope: "migration".into(),
        source: ledger.ledger_class.into(),
        target_version: highest.to_string(),
        operation: format!("{}-pending-migrations", ledger.pending_versions.len()),
      }],
    )?;
    ensure!(
      unresolved == 0,
      "recovery preview has {unresolved} unresolved system identities; no changes were made"
    );
    Ok(())
  }
  .await;
  tx.rollback().await?;
  output.finish()?;
  result
}

/// Recovery uses a captured release, exact Registry identities and explicit orphan
/// keys. Titles and actorless authorship alone never select documents for deletion.
#[instrument(skip_all, fields(workspace_id = ?workspace, apply = args.apply))]
async fn inspect(
  args: &RecoveryArgs,
  workspace: Option<Uuid>,
  connection: &mut PgConnection,
  feature_sources: &myoxus_infrastructure::feature_bundles::CapturedFeatureSourceSet,
) -> anyhow::Result<RecoveryPlan> {
  ensure!(
    args.orphan_sources.len() + args.unknown_sources.len() <= 500,
    "at most 500 exact source overrides may be selected"
  );
  ensure!(
    args.retired_slugs.iter().collect::<BTreeSet<_>>().len() == args.retired_slugs.len(),
    "duplicate withdrawn slug"
  );
  let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND deleted_at IS NULL)")
    .bind(workspace)
    .fetch_one(&mut *connection)
    .await?;
  ensure!(workspace.is_none() || exists, "workspace does not exist");
  // Migration 1045 gives previously existing Workspaces legacy-default policy.
  // The optional projection is also readable on the canonical pre-1045 schema.
  let initial_content: Option<String> = if workspace.is_none() {
    Some("empty".into())
  } else {
    sqlx::query_scalar("SELECT to_jsonb(w)->>'initial_content_policy' FROM workspaces w WHERE id=$1")
      .bind(workspace)
      .fetch_one(&mut *connection)
      .await?
  };

  let mut release = BTreeMap::<String, ReleaseSource>::new();
  for bundle in &feature_sources.bundles {
    let active = feature_sources.resolved.active.contains(&bundle.pin());
    for component in &bundle.manifest.components {
      if component.kind != FeatureComponentKind::DocumentTemplate {
        continue;
      }
      let identity = component
        .native_identity
        .as_ref()
        .context("native document identity missing")?;
      let source = release.entry(identity.id.clone()).or_default();
      let parsed = bundle::parse_bundle(&bundle.files[&component.path])?;
      source.guide |= parsed.manifest.purpose == Some(bundle::TemplatePurpose::Guide);
      source.revisions.insert(identity.version.clone(), parsed);
      if active {
        for export in bundle
          .manifest
          .exports
          .iter()
          .filter(|export| export.source.component == component.id)
        {
          ensure!(source.version.is_none(), "duplicate current document export");
          source.version = Some(identity.version.clone());
          source.default = export
            .document
            .as_ref()
            .is_some_and(|document| document.new_workspace_default);
        }
      }
    }
  }
  for slug in &args.retired_slugs {
    ensure!(
      release.get(slug).is_none_or(|source| source.version.is_none()),
      "cannot retire a current release export: {slug}"
    );
    release.entry(slug.clone()).or_default();
  }
  // Complete selection also withdraws identities absent from the new archive.
  // Discover only positive native release ownership; a pre-marker publication
  // is never reclassified from NULL authorship or an absent component.
  let ownership_column: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='template_revisions' AND column_name='release_managed_publication')")
    .fetch_one(&mut *connection).await?;
  let mut omitted = BTreeSet::new();
  if ownership_column {
    let previous: Vec<String> = sqlx::query_scalar("SELECT DISTINCT c.slug FROM template_catalog_entries c JOIN template_revisions r ON r.template_id=c.id WHERE c.source='bundle' AND r.release_managed_publication AND r.published_at IS NOT NULL AND r.state IN ('published','deprecated')")
      .fetch_all(&mut *connection).await?;
    for slug in previous {
      if release.get(&slug).is_none_or(|source| source.revisions.is_empty()) {
        omitted.insert(slug.clone());
        release.entry(slug).or_default();
      }
    }
  }
  ensure!(!release.is_empty(), "release has no document sources");
  let mut orphans = BTreeMap::new();
  for value in args.orphan_sources.iter().chain(&args.unknown_sources) {
    let (slug, key) = value
      .split_once('=')
      .context("source overrides require SLUG=EXTERNAL_KEY")?;
    ensure!(
      release.get(slug).is_some_and(|source| !source.guide) && !key.is_empty(),
      "unknown orphan source identity"
    );
    ensure!(
      orphans.insert(slug.to_owned(), key.to_owned()).is_none(),
      "duplicate orphan source slug"
    );
  }
  ensure!(
    orphans.values().collect::<BTreeSet<_>>().len() == orphans.len(),
    "an orphan key cannot belong to two source slugs"
  );
  let slugs: Vec<_> = release.keys().cloned().collect();
  let catalog: Vec<Catalog> =
    sqlx::query_as("SELECT c.id,c.slug,c.source,c.status,EXISTS(SELECT 1 FROM template_revisions r WHERE r.template_id=c.id AND r.state='published' AND r.created_by IS NOT NULL) AS operator_current FROM template_catalog_entries c WHERE c.slug=ANY($1) ORDER BY c.id")
      .bind(&slugs)
      .fetch_all(&mut *connection)
      .await?;
  let ids: Vec<_> = catalog.iter().map(|entry| entry.id).collect();
  // The SQL parser cannot reference a missing pre-1047 column, even in a CASE.
  // Authorship is intentionally absent: NULL is not publication provenance.
  let unknown_sql = format!(
    "SELECT template_id FROM template_revisions WHERE template_id=ANY($1) AND state='published' AND {}",
    if ownership_column {
      "NOT release_managed_publication"
    } else {
      "true"
    }
  );
  let unknown: Vec<Uuid> = sqlx::query_scalar(&unknown_sql)
    .bind(&ids)
    .fetch_all(&mut *connection)
    .await?;
  let default_column: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='template_default_policies' AND column_name='release_managed')")
    .fetch_one(&mut *connection).await?;
  let default_sql = format!(
    "SELECT template_id FROM template_default_policies WHERE template_id=ANY($1) AND apply_to_new_workspaces AND selection_mode='published' AND provisioning_mode IN ('seed_once','managed_until_local_edit') AND {}",
    if default_column { "NOT release_managed" } else { "true" }
  );
  let unknown_defaults: Vec<Uuid> = sqlx::query_scalar(&default_sql)
    .bind(&ids)
    .fetch_all(&mut *connection)
    .await?;
  let assignments: Vec<Assignment> = sqlx::query_as(
    "SELECT p.id,p.template_id,c.slug,p.selection_mode,p.provisioning_mode,p.is_enabled,i.state,r.version,
       COALESCE(d.external_id,i.workspace_doc_key) AS document_key,
       (d.id IS NOT NULL AND d.deleted_at IS NULL) AS document_exists,
        COALESCE(i.revision_id IS NOT NULL AND r.template_id=p.template_id,false) AS has_revision,
       COALESCE(r.manifest_json->>'purpose'='guide',false) AS guide_copy,
       COALESCE(n.state IN ('managed','seeded') AND (n.template_id IS NULL OR n.template_id=p.template_id)
          AND (n.instance_id IS NULL OR n.instance_id=i.id) AND (n.revision_id IS NULL OR n.revision_id=i.revision_id),false) AS native_source,
        EXISTS(SELECT 1 FROM template_registry_audit_events a WHERE a.instance_id=i.id
          AND a.event_type='template.instance.detached' AND a.created_at>=i.updated_at
          AND a.payload_json->>'source_binding_relinquished'='true') AS preserved_source,
        d.id AS document_id,i.locale_hash AS locale
     FROM workspace_template_policies p JOIN template_catalog_entries c ON c.id=p.template_id
     LEFT JOIN workspace_template_instances i ON i.workspace_id=p.workspace_id AND i.template_id=p.template_id
     LEFT JOIN template_revisions r ON r.id=i.revision_id
      LEFT JOIN docs d ON d.id=i.workspace_doc_id AND d.workspace_id=p.workspace_id
      LEFT JOIN document_template_state n ON n.doc_id=d.id
     WHERE p.workspace_id=$1 ORDER BY c.slug",
  )
   .bind(workspace)
  .fetch_all(&mut *connection)
  .await?;
  let opted_out: Vec<Uuid> = sqlx::query_scalar("SELECT template_id FROM workspace_template_instances WHERE workspace_id=$1 AND template_id=ANY($2) AND (state IN ('retired','detached') OR retired_at IS NOT NULL)")
    .bind(workspace).bind(&ids).fetch_all(&mut *connection).await?;

  // A detached migration source has lost its Registry identity. Only an exact
  // operator-supplied key with positive native template state may be removed.
  let mut source_deletions = Vec::new();
  for (slug, key) in &orphans {
    ensure!(
      !assignments.iter().any(|assignment| catalog
        .iter()
        .any(|entry| entry.slug == *slug && entry.id == assignment.template_id)
        && assignment.guide_copy),
      "reader guide copies cannot be selected as replacement sources"
    );
    let selected_unknown = args
      .unknown_sources
      .iter()
      .any(|value| value.split_once('=').is_some_and(|(id, _)| id == slug));
    let valid: bool = sqlx::query_scalar(
      "SELECT NOT EXISTS(SELECT 1 FROM docs WHERE workspace_id=$1 AND external_id=$2)
       OR EXISTS(SELECT 1 FROM docs d JOIN document_template_state s ON s.doc_id=d.id
         WHERE d.workspace_id=$1 AND d.external_id=$2 AND NOT d.is_workspace_root
          AND s.state IN ('seeded','managed','detached')
           AND (s.template_id IS NULL OR ($3 AND s.template_id=(SELECT id FROM template_catalog_entries WHERE slug=$4)))
           AND (s.instance_id IS NULL OR ($3 AND EXISTS(SELECT 1 FROM workspace_template_instances i WHERE i.id=s.instance_id AND i.workspace_id=$1 AND i.template_id=(SELECT id FROM template_catalog_entries WHERE slug=$4))))
           AND (s.revision_id IS NULL OR ($3 AND EXISTS(SELECT 1 FROM workspace_template_instances i
             JOIN workspace_template_policies p ON p.workspace_id=i.workspace_id AND p.template_id=i.template_id
             WHERE i.workspace_id=$1 AND i.template_id=(SELECT id FROM template_catalog_entries WHERE slug=$4)
               AND i.revision_id=s.revision_id AND (i.workspace_doc_id=d.id OR i.workspace_doc_key=d.external_id OR i.workspace_doc_key=d.id::text))))
           AND NOT EXISTS(SELECT 1 FROM workspace_template_instances i WHERE i.workspace_id=$1
             AND (i.workspace_doc_id=d.id OR i.workspace_doc_key=d.external_id OR i.workspace_doc_key=d.id::text)
             AND (NOT $3 OR i.template_id<>(SELECT id FROM template_catalog_entries WHERE slug=$4)
               OR NOT EXISTS(SELECT 1 FROM workspace_template_policies p WHERE p.workspace_id=i.workspace_id AND p.template_id=i.template_id))))",
    )
    .bind(workspace)
    .bind(key)
    .bind(selected_unknown)
    .bind(slug)
    .fetch_one(&mut *connection)
    .await?;
    ensure!(valid, "orphan source is not an unbound native template: {key}");
    // Confirmation applies to this observed identity/body, not a future document
    // created with the same key or an edit arriving during materialization.
    let captured: Option<CapturedSourceDeletion> = sqlx::query_as(
      "SELECT d.id AS document_id,d.external_id AS source_key,
        GREATEST(COALESCE((SELECT max(sequence) FROM doc_updates u WHERE u.workspace_id=d.workspace_id AND u.doc_id=d.id),0),
          COALESCE((SELECT last_sequence FROM doc_snapshots s WHERE s.workspace_id=d.workspace_id AND s.doc_id=d.id),0)) AS revision
       FROM docs d WHERE d.workspace_id=$1 AND d.external_id=$2")
      .bind(workspace).bind(key).fetch_optional(&mut *connection).await?;
    source_deletions.extend(captured);
  }

  let mut desired = BTreeSet::new();
  let mut replacements = Vec::new();
  let mut replaced_keys = Vec::new();
  let mut output = Vec::new();
  let mut unresolved = 0;
  let mut attested_publications = Vec::new();
  let mut attested_defaults = Vec::new();
  for (slug, source) in &release {
    if !catalog.iter().any(|entry| entry.slug == *slug) {
      output.push(RecoveryRow {
        workspace: String::new(),
        scope: "release".into(),
        source: slug.clone(),
        target_version: source.version.clone().unwrap_or_else(|| "history".into()),
        operation: if source.default && initial_content.as_deref() != Some("empty") {
          "new-default"
        } else {
          "register-history-or-export"
        }
        .into(),
      });
    }
  }
  for entry in &catalog {
    let source = &release[&entry.slug];
    let assignment = assignments.iter().find(|assignment| assignment.template_id == entry.id);
    let legacy_binding = assignment.is_some_and(|assignment| assignment.state.is_some() && !assignment.has_revision);
    let lost_unknown = assignment
      .is_some_and(|assignment| assignment.state.as_deref() == Some("detached") && !assignment.document_exists)
      && !assignment.is_some_and(|assignment| assignment.preserved_source)
      && !orphans.contains_key(&entry.slug);
    let mut legacy_preserved = false;
    let mut legacy_resolved = false;
    if legacy_binding && let Some(baseline) = source.baseline(&entry.slug) {
      let mut after = None;
      loop {
        let workspace = workspace.context("legacy source requires a Workspace")?;
        let rows =
          SqlxTemplateRegistryStore::pending_released_builtin_workspace_page_in(connection, entry.id, workspace, after)
            .await?;
        if rows.is_empty() {
          break;
        }
        for observed in rows {
          after = Some(observed.id);
          let mut adoption = ReleasedBuiltinAdoption {
            observed,
            revision_id: Uuid::nil(),
            content_revision: None,
            current_hash: None,
            unchanged: false,
          };
          if adoption.observed.source_available {
            let body = myoxus_infrastructure::doc::SqlxDocStore::load_full_doc_bounded_in_snapshot(
              connection,
              workspace,
              adoption
                .observed
                .resolved_doc_id
                .context("live legacy source has no document identity")?,
              myoxus_application::template_registry::TemplateRegistryZipLimits::default()
                .max_total_uncompressed_size_mb
                .saturating_mul(1024 * 1024) as usize,
            )
            .await?;
            adoption.attest_baseline(entry.id, baseline, &body)?;
          }
          let purpose = baseline.manifest.purpose.context("frozen baseline has no purpose")?;
          legacy_preserved |= !adoption.retains_source_binding(purpose);
          legacy_resolved = true;
        }
      }
    }
    let mut frozen_publication = false;
    if let Some(baseline) = source.baseline(&entry.slug) {
      let published = SqlxTemplateRegistryStore::published_revisions_in(connection, entry.id).await?;
      frozen_publication = !published.is_empty()
        && published
          .iter()
          .all(|revision| attest_shipped_revision(revision, baseline).is_ok());
      if frozen_publication {
        attested_publications.extend(published.iter().map(|revision| revision.id));
      }
    }
    let frozen_owner = source.baseline(&entry.slug).is_some() && entry.source == "builtin" && !entry.operator_current;
    let default_attested = (frozen_owner && !unknown.contains(&entry.id)) || frozen_publication;
    if default_attested {
      attested_defaults.push(entry.id);
    }
    let current = source.version.is_some() && entry.status == "active";
    let mut native_edited = false;
    if let Some(assignment) = assignment.filter(|assignment| {
      !entry.operator_current
        && assignment.native_source
        && assignment.has_revision
        && assignment.document_exists
        && !assignment.guide_copy
        && assignment.is_enabled
        && assignment.selection_mode == "published"
        && assignment.provisioning_mode == "managed_until_local_edit"
        && (!current || assignment.version != source.version)
        && !orphans.contains_key(&entry.slug)
    }) {
      // An omitted component has no candidate bytes to compare here. Normal
      // retirement loads its stored native revision and preserves edited bodies;
      // preview reports that conditional operation instead of guessing content.
      if let Some(parsed) = assignment
        .version
        .as_ref()
        .and_then(|version| source.revisions.get(version))
      {
        let body = myoxus_infrastructure::doc::SqlxDocStore::load_full_doc_bounded_in_snapshot(
          connection,
          workspace.context("native source requires a Workspace")?,
          assignment
            .document_id
            .context("native source has no document identity")?,
          myoxus_application::template_registry::TemplateRegistryZipLimits::default()
            .max_total_uncompressed_size_mb
            .saturating_mul(1024 * 1024) as usize,
        )
        .await?;
        let locale = parsed.select_locale(assignment.locale.as_deref().unwrap_or("en"));
        native_edited =
          !yjs::native_documents_have_same_content(&body, parsed.content_for_locale(&locale)).unwrap_or(false);
      } else if !omitted.contains(&entry.slug) {
        unresolved += 1;
        output.push(RecoveryRow {
          workspace: String::new(),
          scope: "release".into(),
          source: entry.slug.clone(),
          target_version: source.version.clone().unwrap_or_else(|| "withdrawn".into()),
          operation: "unresolved-source-attestation".into(),
        });
      }
    }
    // Exact confirmed recovery remains an explicit repair request; an ordinary
    // release replay must respect an opt-out even after its policy was removed.
    let preserved = entry.operator_current
      || (assignment.is_none() && opted_out.contains(&entry.id) && !orphans.contains_key(&entry.slug))
      || native_edited
      || legacy_preserved
      || assignment.is_some_and(|assignment| {
        !assignment.is_enabled
          || assignment.selection_mode != "published"
          || assignment.provisioning_mode == "manual_update"
          || (assignment.state.as_deref() == Some("detached")
            && !orphans.contains_key(&entry.slug)
            && (assignment.document_exists || assignment.preserved_source))
          || (assignment.document_exists && !assignment.native_source && !assignment.guide_copy)
          || (assignment.guide_copy && (assignment.state.as_deref() == Some("retired") || !assignment.document_exists))
      })
      || (entry.status != "active" && !args.retired_slugs.contains(&entry.slug));
    let ownership_operation = if entry.operator_current {
      if entry.source == "builtin" {
        unresolved += 1;
        Some("unresolved-frozen-builtin-operator-current")
      } else {
        Some("preserve-operator-publication")
      }
    } else if frozen_owner {
      if unknown.contains(&entry.id) && !frozen_publication && !args.confirm_unmodified_system_documents {
        unresolved += 1;
        Some("unresolved-publication-ownership")
      } else {
        Some("frozen-ownership-transfer")
      }
    } else if entry.source == "builtin" {
      unresolved += 1;
      Some("unresolved-frozen-builtin")
    } else if entry.source != "bundle" {
      unresolved += 1;
      Some("unresolved-catalog-owner")
    } else if unknown.contains(&entry.id) {
      if frozen_publication {
        Some("attested-publication-transfer")
      } else if args.confirm_unmodified_system_documents {
        Some("ownership-transfer")
      } else {
        unresolved += 1;
        Some("unresolved-publication-ownership")
      }
    } else {
      None
    };
    if let Some(operation) = ownership_operation {
      output.push(RecoveryRow {
        workspace: String::new(),
        scope: "catalog".into(),
        source: entry.slug.clone(),
        target_version: source.version.clone().unwrap_or_else(|| "withdrawn".into()),
        operation: operation.into(),
      });
    }
    if unknown_defaults.contains(&entry.id) && !entry.operator_current {
      if !args.confirm_unmodified_system_documents && !default_attested {
        unresolved += 1;
      }
      output.push(RecoveryRow {
        workspace: String::new(),
        scope: "default".into(),
        source: entry.slug.clone(),
        target_version: source.version.clone().unwrap_or_else(|| "withdrawn".into()),
        operation: if default_attested {
          "attested-default-transfer"
        } else if args.confirm_unmodified_system_documents {
          "ownership-transfer"
        } else {
          "unresolved-default-ownership"
        }
        .into(),
      });
    }
    if (legacy_binding && !legacy_resolved) || (lost_unknown && !preserved) {
      unresolved += 1;
    }
    if preserved {
      orphans.remove(&entry.slug);
    }
    if current
      && !preserved
      && !lost_unknown
      && (assignment.is_some() || (source.default && initial_content.as_deref() != Some("empty")))
    {
      desired.insert(entry.id);
    }
    let operation = if legacy_binding && !legacy_resolved {
      "unresolved-native-legacy-binding"
    } else if legacy_preserved || native_edited {
      if native_edited && !current {
        replacements.push(assignment.expect("native edit belongs to an assignment").clone());
      }
      "preserve-edited-source"
    } else if legacy_binding {
      if source.guide {
        "adopt-reader-copy"
      } else {
        "adopt-native-source"
      }
    } else if lost_unknown && !preserved {
      "unresolved-source-identity"
    } else if preserved {
      "preserve-explicit-policy"
    } else if let Some(assignment) = assignment {
      if current && assignment.state.is_none() {
        "install"
      } else if current && (assignment.guide_copy || source.guide) {
        "preserve-reader-copy"
      } else if !current {
        replacements.push(assignment.clone());
        if omitted.contains(&entry.slug) {
          "retire-with-native-attestation"
        } else {
          "remove"
        }
      } else if assignment.document_exists
        && assignment.state.as_deref() == Some("ok")
        && assignment.version == source.version
      {
        "current"
      } else if assignment.native_source && assignment.document_exists && assignment.has_revision {
        "update"
      } else if !assignment.document_exists
        && assignment.has_revision
        && assignment.state.as_deref() != Some("detached")
      {
        "repair"
      } else {
        replacements.push(assignment.clone());
        "replace"
      }
    } else if desired.contains(&entry.id) {
      "install"
    } else {
      "select-catalog"
    };
    output.push(RecoveryRow {
      workspace: String::new(),
      scope: "release".into(),
      source: entry.slug.clone(),
      target_version: source.version.clone().unwrap_or_else(|| "withdrawn".into()),
      operation: operation.into(),
    });
    if desired.contains(&entry.id) {
      if matches!(operation, "replace" | "repair") {
        if let Some(key) = assignment.and_then(|assignment| assignment.document_key.clone()) {
          replaced_keys.push((entry.id, key));
        }
      }
      if let Some(key) = orphans.get(&entry.slug) {
        replaced_keys.push((entry.id, key.clone()));
      }
    }
  }
  for key in orphans.values() {
    if !args.confirm_unmodified_system_documents {
      unresolved += 1;
    }
    output.push(RecoveryRow {
      workspace: String::new(),
      scope: "orphan".into(),
      source: key.clone(),
      target_version: String::new(),
      operation: if args.confirm_unmodified_system_documents {
        if source_deletions.iter().any(|source| source.source_key == *key) {
          "remove-if-present"
        } else {
          "already-absent"
        }
      } else {
        "unresolved-source-confirmation"
      }
      .into(),
    });
  }
  Ok(RecoveryPlan {
    catalog,
    desired,
    replacements,
    replaced_keys,
    orphans,
    output,
    unresolved,
    attested_publications,
    attested_defaults,
    source_deletions,
  })
}

#[instrument(skip_all, fields(workspace_id = ?args.workspace_id, all_workspaces = args.all_workspaces, apply = args.apply))]
pub async fn run(args: RecoveryArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let mut output = RecoveryOutput { json, written: false };
  let result: anyhow::Result<()> = async {
    prepare_release(&args, svc, &mut output).await?;
    let mut after = None;
    loop {
      let workspaces = if args.all_workspaces {
        svc.template_registry.store().release_workspace_ids(after, 100).await?
      } else if after.is_none() {
        vec![args.workspace_id.context("select a Workspace scope")?]
      } else {
        vec![]
      };
      if workspaces.is_empty() {
        break;
      }
      for workspace in workspaces {
        run_workspace(&args, workspace, svc, &mut output).await?;
        after = Some(workspace);
      }
    }
    Ok(())
  }
  .await;
  output.finish()?;
  result
}

/// History admission and frozen adoption precede current selection, even with
/// no active Workspaces. Global ownership is never inferred from an empty page.
async fn prepare_release(args: &RecoveryArgs, svc: &Services, output: &mut RecoveryOutput) -> anyhow::Result<()> {
  ensure!(args.apply, "preview must be dispatched before CLI service bootstrap");
  let mut snapshot = svc.pool.begin().await?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    .execute(&mut *snapshot)
    .await?;
  // Validate the selected Workspace and exact overrides before any global
  // history/ownership write. A mistyped scope must not partially activate it.
  let mut plan = inspect(args, args.workspace_id, &mut snapshot, &svc.feature_sources).await?;
  snapshot.rollback().await?;
  output.rows(args.workspace_id, &mut plan.output)?;
  ensure!(plan.unresolved == 0, "recovery has unresolved global system ownership");
  let selection = myoxus_application::feature_bundle::stage_feature_document_sources(
    &svc.template_registry,
    &svc.feature_sources.bundles,
    &svc.feature_sources.resolved.active,
  )
  .await?;
  let mut adopted = BTreeSet::new();
  for bundle in &svc.feature_sources.bundles {
    for component in &bundle.manifest.components {
      if component.kind != FeatureComponentKind::DocumentTemplate {
        continue;
      }
      let identity = component
        .native_identity
        .as_ref()
        .context("missing native document identity")?;
      if released_system_baseline_version(&identity.id) == Some(identity.version.as_str())
        && adopted.insert(identity.id.clone())
      {
        svc
          .template_registry
          .adopt_released_builtin_baseline(&bundle.files[&component.path], &component.path)
          .await?;
      }
    }
  }
  let ids: Vec<_> = plan
    .catalog
    .iter()
    .filter(|entry| !entry.operator_current)
    .map(|entry| entry.id)
    .collect();
  let mut tx = svc.pool.begin().await?;
  // Recheck authority under the same catalog lock used by publication. Only
  // exact attested revisions (or explicit operator confirmation) can be acquired.
  sqlx::query("SELECT id FROM template_catalog_entries WHERE id=ANY($1) ORDER BY id FOR NO KEY UPDATE")
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
  let authored: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM template_revisions WHERE template_id=ANY($1) AND state='published' AND created_by IS NOT NULL)")
    .bind(&ids).fetch_one(&mut *tx).await?;
  ensure!(!authored, "publication changed after recovery inspection");
  let unknown: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM template_revisions WHERE template_id=ANY($1) AND state='published' AND NOT release_managed_publication AND NOT(id=ANY($2)))")
    .bind(&ids).bind(&plan.attested_publications).fetch_one(&mut *tx).await?;
  ensure!(
    args.confirm_unmodified_system_documents || !unknown,
    "publication authority changed after inspection"
  );
  sqlx::query("UPDATE template_revisions SET release_managed_publication=true WHERE template_id=ANY($1) AND state='published' AND created_by IS NULL AND ($2 OR id=ANY($3))")
    .bind(&ids).bind(args.confirm_unmodified_system_documents).bind(&plan.attested_publications).execute(&mut *tx).await?;
  sqlx::query("UPDATE template_default_policies SET release_managed=true WHERE template_id=ANY($1) AND apply_to_new_workspaces AND selection_mode='published' AND provisioning_mode IN ('seed_once','managed_until_local_edit') AND ($2 OR template_id=ANY($3))")
    .bind(&ids).bind(args.confirm_unmodified_system_documents).bind(&plan.attested_defaults).execute(&mut *tx).await?;
  sqlx::query("INSERT INTO template_registry_audit_events(action,event_type,workspace_id,payload_json) VALUES('updated','template.release.recovery',$1,$2)")
    .bind(args.workspace_id).bind(serde_json::json!({"release":svc.feature_sources.release.base,"all_workspaces":args.all_workspaces,"orphan_source_keys":args.orphan_sources,"unknown_source_keys":args.unknown_sources}))
    .execute(&mut *tx).await?;
  tx.commit().await?;
  let registered = svc
    .template_registry
    .commit_shipped_catalog_selection(&selection)
    .await?;
  ensure!(
    registered.operator_current_preserved.iter().all(|id| plan
      .catalog
      .iter()
      .any(|entry| entry.id == *id && entry.operator_current)),
    "publication authority changed during recovery"
  );
  for slug in &args.retired_slugs {
    let entry = plan
      .catalog
      .iter()
      .find(|entry| entry.slug == *slug)
      .context("withdrawn source missing")?;
    if entry.operator_current {
      continue;
    }
    // Archiving disables all policies and would erase explicit opt-out intent
    // before bounded retirement. End delivery without invalidating genuine pins.
    sqlx::query("UPDATE template_revisions SET state='deprecated' WHERE template_id=$1 AND state='published' AND release_managed_publication")
      .bind(entry.id).execute(&svc.pool).await?;
    sqlx::query(
      "UPDATE template_default_policies SET apply_to_new_workspaces=false WHERE template_id=$1 AND release_managed",
    )
    .bind(entry.id)
    .execute(&svc.pool)
    .await?;
  }
  Ok(())
}

async fn run_workspace(
  args: &RecoveryArgs,
  workspace: Uuid,
  svc: &Services,
  output: &mut RecoveryOutput,
) -> anyhow::Result<()> {
  ensure!(args.apply, "preview must be dispatched before CLI service bootstrap");
  ensure!(
    (args.orphan_sources.is_empty() && args.unknown_sources.is_empty()) || args.confirm_unmodified_system_documents,
    "exact source replacement requires --confirm-unmodified-system-documents"
  );
  let mut snapshot = svc.pool.begin().await?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    .execute(&mut *snapshot)
    .await?;
  let mut plan = inspect(args, Some(workspace), &mut snapshot, &svc.feature_sources).await?;
  snapshot.rollback().await?;
  output.rows(Some(workspace), &mut plan.output)?;
  ensure!(plan.unresolved == 0, "recovery has unresolved system identities");
  let RecoveryPlan {
    catalog,
    desired,
    replacements,
    replaced_keys,
    orphans,
    output: _,
    unresolved: _,
    attested_publications: _,
    attested_defaults: _,
    source_deletions,
  } = plan;
  for assignment in replacements {
    let entry = catalog
      .iter()
      .find(|entry| entry.id == assignment.template_id)
      .context("replacement catalog identity missing")?;
    if !orphans.contains_key(&entry.slug) {
      svc
        .template_registry
        .retire_unchanged_template_assignment(assignment.id)
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
      continue;
    }
    // Keep the selected old body until a replacement is durable. Relinquishing
    // this binding makes normal retirement remove only delivery ownership.
    svc
      .template_registry
      .store()
      .preserve_source_as_custom(workspace, assignment.template_id)
      .await
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    svc
      .template_registry
      .retire_template_assignment(assignment.id)
      .await
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  }
  let remaining = svc
    .template_registry
    .store()
    .list_policies_for_workspace(workspace)
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  for id in &desired {
    if !remaining.iter().any(|policy| policy.template_id == *id) {
      svc
        .template_registry
        .assign_template_to_workspace(
          workspace,
          *id,
          SelectionMode::Published,
          None,
          ProvisioningMode::ManagedUntilLocalEdit,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    }
  }
  let instances = svc
    .template_registry
    .reconcile_workspace_templates(workspace)
    .await
    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
  for id in desired {
    ensure!(
      instances.iter().any(|instance| instance.template_id == id
        && instance.workspace_doc_key.is_some()
        && instance.state == myoxus_domain::template_registry::InstanceState::Ok),
      "recovery source materialization did not complete: {id}"
    );
  }
  let selected_keys: BTreeSet<_> = orphans.into_values().collect();
  let retired_sources = source_deletions
    .into_iter()
    .filter(|source| {
      selected_keys.contains(&source.source_key)
        && !instances
          .iter()
          .any(|instance| instance.workspace_doc_key.as_ref() == Some(&source.source_key))
    })
    .collect();
  delete_sources(svc, workspace, retired_sources).await?;
  // Publish preference translations only after the old source was deleted and
  // the replacement is durable. No retirement-intent fence is needed here.
  for (id, old_key) in replaced_keys {
    let new_key = instances
      .iter()
      .find(|instance| instance.template_id == id)
      .and_then(|instance| instance.workspace_doc_key.as_ref())
      .context("replacement binding missing")?;
    if &old_key == new_key {
      continue;
    }
    sqlx::query("INSERT INTO template_registry_audit_events(action,event_type,workspace_id,template_id,payload_json)
      SELECT 'updated','template.default.replaced',$1,$2,$3 WHERE NOT EXISTS(
        SELECT 1 FROM template_registry_audit_events WHERE workspace_id=$1 AND event_type='template.default.replaced'
          AND payload_json->>'retired_source_doc_id'=$4 AND payload_json->>'replacement_source_doc_id'=$5)")
      .bind(workspace).bind(id)
      .bind(serde_json::json!({"retired_source_doc_id":old_key,"replacement_source_doc_id":new_key,"replacement_template_id":id}))
      .bind(&old_key).bind(new_key).execute(&svc.pool).await?;
  }
  info!(workspace_id = %workspace, "explicit system document recovery completed");
  Ok(())
}

async fn delete_sources(
  svc: &Services,
  workspace_id: Uuid,
  sources: Vec<CapturedSourceDeletion>,
) -> anyhow::Result<()> {
  for source in sources {
    let result = svc
      .doc
      .permanently_delete_confirmed_template_source_at_revision(
        PermanentDeleteRequest {
          workspace_id,
          actor_user_id: None,
          mode: PermanentDeleteMode::SelectedDocs,
          doc_ids: vec![source.source_key],
        },
        source.document_id,
        source.revision,
      )
      .await
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    if !result.is_success() {
      bail!(
        "source deletion did not complete for document {}: {} failed, {} forbidden; inspect the source and renew confirmation before retrying",
        source.document_id,
        result.failed,
        result.forbidden
      );
    }
  }
  Ok(())
}
