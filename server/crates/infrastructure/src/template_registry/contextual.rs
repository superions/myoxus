// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded contextual metadata reads. Ranking parameters originate in Application.

use super::{
  SqlxTemplateRegistryStore,
  library::{SOURCE_BINDINGS_SQL, SOURCE_REVISIONS_SQL},
};
use myoxus_application::{
  auth::{AuthError, AuthResult},
  template_registry::{
    TemplatePageDefaultReplacement,
    suggestions::{ContextualGuideDelivery, ContextualTemplatePage, ContextualTemplateQuery, ContextualTemplateSource},
  },
};
use sqlx::Row;
use uuid::Uuid;

impl SqlxTemplateRegistryStore {
  #[tracing::instrument(skip_all, fields(workspace_id = %workspace))]
  pub(super) async fn read_contextual_page_default_replacements(
    &self,
    workspace: Uuid,
  ) -> AuthResult<Vec<TemplatePageDefaultReplacement>> {
    // Preserve the existing latest-200 audit window and physical-retirement
    // attestation. A retained edited/custom source must not clear a preference.
    let rows=sqlx::query(r#"
      WITH recent AS MATERIALIZED (
        SELECT payload_json,created_at,id FROM template_registry_audit_events
        WHERE workspace_id=$1 AND event_type='template.default.replaced'
        ORDER BY created_at DESC,id DESC LIMIT 200
      ), facts AS (
        SELECT payload_json->>'retired_source_doc_id' AS retired,
          NULLIF(payload_json->>'replacement_source_doc_id','') AS replacement,created_at,id
        FROM recent WHERE jsonb_typeof(payload_json->'retired_source_doc_id')='string'
      ), retired AS (
        SELECT DISTINCT ON (f.retired) f.* FROM facts f
        WHERE btrim(f.retired)<>'' AND NOT EXISTS (
          SELECT 1 FROM docs WHERE workspace_id=$1 AND external_id=f.retired
        ) AND NOT EXISTS (
          SELECT 1 FROM docs WHERE workspace_id=$1 AND userspace_owner_id IS NULL AND id=CASE
            WHEN f.retired ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN f.retired::uuid END
        ) ORDER BY f.retired,f.created_at DESC,f.id DESC
      )
      SELECT retired,CASE WHEN target.id IS NOT NULL AND target.deleted_at IS NULL
        AND NOT target.blocked AND NOT target.is_workspace_root THEN replacement END AS replacement
      FROM retired LEFT JOIN LATERAL (
        SELECT id,deleted_at,blocked,is_workspace_root FROM docs
        WHERE workspace_id=$1 AND external_id=retired.replacement LIMIT 1
      ) external_target ON TRUE
      LEFT JOIN docs target ON target.workspace_id=$1 AND target.id=COALESCE(external_target.id,CASE
        WHEN retired.replacement ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN retired.replacement::uuid END)
      ORDER BY retired.created_at DESC,retired.id DESC
    "#).bind(workspace).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    rows
      .into_iter()
      .map(|row| {
        Ok(TemplatePageDefaultReplacement {
          retired_source_doc_id: row.try_get("retired").map_err(Self::map_db_err)?,
          replacement_source_doc_id: row.try_get("replacement").map_err(Self::map_db_err)?,
        })
      })
      .collect()
  }
  #[tracing::instrument(skip_all, fields(workspace_id = %query.workspace_id, limit = query.limit))]
  pub(super) async fn read_contextual_template_page(
    &self,
    query: &ContextualTemplateQuery,
  ) -> AuthResult<ContextualTemplatePage> {
    if !(1..=21).contains(&query.limit) {
      return Err(AuthError::InvalidInput("invalid contextual page size".into()));
    }
    let sql = format!(
      r#"
      WITH bindings AS MATERIALIZED ({SOURCE_BINDINGS_SQL}), facts AS (
        SELECT c.id AS template_id,c.slug,c.title AS catalog_title,NULLIF(c.description,'') AS catalog_description,
          c.source,c.updated_at,NULLIF(c.category,'general') AS category,c.tags,
          c.min_client_version::bigint>$4::bigint AS incompatible,
          CASE WHEN c.source='builtin' AND w.initial_content_policy='empty' THEN NULL ELSE i.state END AS instance_state,
          CASE WHEN c.source='builtin' AND (w.initial_content_policy='empty' OR COALESCE(t.state NOT IN ('seeded','managed'),TRUE)) THEN NULL
            ELSE i.workspace_doc_key END AS document_key,
          p.provisioning_mode IN ('managed_until_local_edit','manual_update') AS protected_source,
          CASE WHEN c.source='bundle' THEN COALESCE(applied.id,target.id) END AS revision_id,
          CASE WHEN c.source='bundle' THEN COALESCE(applied.manifest_json,target.manifest) END AS manifest,
          i.locale_hash,
          d.id IS NOT NULL AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root AS source_live
        FROM workspace_template_policies p
        JOIN workspaces w ON w.id=p.workspace_id
        JOIN template_catalog_entries c ON c.id=p.template_id
        LEFT JOIN bindings i ON i.workspace_id=p.workspace_id AND i.template_id=c.id
        LEFT JOIN docs d ON d.workspace_id=p.workspace_id AND d.id=i.resolved_doc_id
        LEFT JOIN document_template_state t ON t.doc_id=d.id
        {SOURCE_REVISIONS_SQL}
        WHERE p.workspace_id=$1 AND p.is_enabled AND c.status='active'
          AND ($2::text IS NULL OR c.category=$2)
          AND (NOT $3::boolean OR c.category IS DISTINCT FROM 'building-blocks')
          AND (i.state IS NULL OR i.state<>'retired')
          AND (c.source='builtin' OR i.id IS NULL OR applied.id IS NOT NULL)
          AND ((c.source='builtin' AND c.builder_version IS NOT NULL AND c.category IS DISTINCT FROM 'onboarding')
            OR (c.source='bundle' AND target.id IS NOT NULL AND COALESCE(target.manifest->>'purpose','template')<>'guide'))
      ), labeled AS (
        SELECT facts.*,
          CASE WHEN manifest ?& ARRAY['template_id','version','title'] THEN
            COALESCE(manifest->'localized_contents'->source_locale.locale->>'title',manifest->>'title',catalog_title)
            ELSE catalog_title END AS title,
          CASE WHEN manifest ?& ARRAY['template_id','version','title'] THEN
            CASE WHEN manifest->'localized_contents' ? source_locale.locale THEN manifest->'localized_contents'->source_locale.locale->>'description'
              ELSE manifest->>'description' END
            ELSE catalog_description END AS description,
          CASE WHEN source='bundle' THEN COALESCE(manifest->>'title_policy','template') END AS title_policy
        FROM facts LEFT JOIN LATERAL (
          SELECT candidate.locale FROM (
            SELECT key AS locale,0 AS kind FROM jsonb_object_keys(CASE WHEN jsonb_typeof(manifest->'localized_contents')='object' THEN manifest->'localized_contents' ELSE '{{}}'::jsonb END) key
            UNION ALL SELECT manifest->>'locale',1
          ) candidate
          WHERE lower(replace(candidate.locale,'_','-')) IN (lower(replace(locale_hash,'_','-')),split_part(lower(replace(locale_hash,'_','-')),'-',1)) OR candidate.locale=manifest->>'locale'
          ORDER BY CASE WHEN lower(replace(candidate.locale,'_','-'))=lower(replace(locale_hash,'_','-')) THEN 0
            WHEN lower(replace(candidate.locale,'_','-'))=split_part(lower(replace(locale_hash,'_','-')),'-',1) THEN 1 ELSE 2 END,candidate.kind,candidate.locale LIMIT 1
        ) source_locale ON TRUE
        WHERE (incompatible OR document_key IS NULL OR instance_state NOT IN ('ok','update_available','detached') OR source_live)
          AND (source='builtin' OR (COALESCE(manifest->>'purpose','template')<>'guide'
            AND (manifest->'title_policy' IS NULL OR manifest->'title_policy'='null'::jsonb OR manifest->>'title_policy' IN ('template','template-date','date'))))
      ), ranked AS (
        SELECT labeled.*,COALESCE(NOT incompatible AND document_key IS NOT NULL AND instance_state IN ('ok','update_available','detached'),FALSE) AS available,
          $5::integer+COALESCE((SELECT sum(bonus) FROM unnest($6::text[],$7::integer[]) b(tag,bonus) WHERE tag=ANY(tags)),0)::integer
          +CASE WHEN incompatible OR document_key IS NULL THEN 0 WHEN instance_state='ok' THEN $8::integer
            WHEN instance_state='update_available' THEN $9::integer WHEN instance_state='detached' THEN $10::integer ELSE 0 END AS score
        FROM labeled
      ), deduplicated AS MATERIALIZED (
        SELECT DISTINCT ON (available,CASE WHEN available THEN document_key ELSE template_id::text END) * FROM ranked
        ORDER BY available DESC,CASE WHEN available THEN document_key ELSE template_id::text END,score DESC,title COLLATE "C",slug COLLATE "C",template_id
      ), cursor_row AS (SELECT * FROM deduplicated WHERE template_id=$11), page AS (
        SELECT * FROM deduplicated
        WHERE $11::uuid IS NULL OR
          (NOT available,-score,title COLLATE "C",slug COLLATE "C",template_id) >
          (SELECT NOT available,-score,title COLLATE "C",slug COLLATE "C",template_id FROM cursor_row)
        ORDER BY available DESC,score DESC,title COLLATE "C",slug COLLATE "C",template_id LIMIT $12
      )
      SELECT page.*, $11::uuid IS NULL OR EXISTS(SELECT 1 FROM cursor_row) AS cursor_valid
      FROM (SELECT 1) anchor LEFT JOIN page ON TRUE
      ORDER BY page.available DESC,page.score DESC,page.title COLLATE "C",page.slug COLLATE "C",page.template_id
    "#
    );
    let rows = sqlx::query(&sql)
      .bind(query.workspace_id)
      .bind(query.category)
      .bind(query.exclude_building_blocks)
      .bind(query.client_version as i64)
      .bind(query.base_score)
      .bind(query.tag_bonuses.iter().map(|(tag, _)| tag.clone()).collect::<Vec<_>>())
      .bind(query.tag_bonuses.iter().map(|(_, bonus)| *bonus).collect::<Vec<_>>())
      .bind(query.state_bonuses[0])
      .bind(query.state_bonuses[1])
      .bind(query.state_bonuses[2])
      .bind(query.after)
      .bind(query.limit as i64)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    let mut sources = Vec::new();
    let mut cursor_valid = true;
    for row in rows {
      cursor_valid = row.try_get("cursor_valid").map_err(Self::map_db_err)?;
      let Some(template_id) = row
        .try_get::<Option<Uuid>, _>("template_id")
        .map_err(Self::map_db_err)?
      else {
        continue;
      };
      let policy: Option<String> = row.try_get("title_policy").map_err(Self::map_db_err)?;
      let state: Option<String> = row.try_get("instance_state").map_err(Self::map_db_err)?;
      sources.push(ContextualTemplateSource {
        template_id,
        document_key: row.try_get("document_key").map_err(Self::map_db_err)?,
        slug: row.try_get("slug").map_err(Self::map_db_err)?,
        title: row.try_get("title").map_err(Self::map_db_err)?,
        description: row.try_get("description").map_err(Self::map_db_err)?,
        source: row.try_get("source").map_err(Self::map_db_err)?,
        updated_at: row.try_get("updated_at").map_err(Self::map_db_err)?,
        category: row.try_get("category").map_err(Self::map_db_err)?,
        tags: row.try_get("tags").map_err(Self::map_db_err)?,
        revision_id: row.try_get("revision_id").map_err(Self::map_db_err)?,
        title_policy: policy
          .as_deref()
          .map(|value| serde_json::from_value(serde_json::Value::String(value.into())))
          .transpose()
          .map_err(|_| AuthError::Storage("invalid source title policy".into()))?,
        state: state.as_deref().map(super::instance_state_from_db).transpose()?,
        incompatible: row.try_get("incompatible").map_err(Self::map_db_err)?,
        protected_source: row.try_get("protected_source").map_err(Self::map_db_err)?,
        score: row.try_get("score").map_err(Self::map_db_err)?,
      });
    }
    Ok(ContextualTemplatePage { sources, cursor_valid })
  }

  #[tracing::instrument(skip_all, fields(workspace_id = %workspace))]
  pub(super) async fn read_contextual_guide_deliveries(
    &self,
    workspace: Uuid,
  ) -> AuthResult<Vec<ContextualGuideDelivery>> {
    let sql = format!(
      r#"
      WITH bindings AS MATERIALIZED ({SOURCE_BINDINGS_SQL})
      SELECT c.slug,CASE WHEN d.id IS NOT NULL THEN COALESCE(i.workspace_doc_key,i.workspace_doc_id::text) END AS document_key,
        d.id AS document_id,
        COALESCE(p.is_enabled,FALSE) AND c.status='active' AND (i.id IS NULL OR (i.state='error' AND i.workspace_doc_key IS NULL AND i.workspace_doc_id IS NULL)) AS pending
      FROM template_catalog_entries c
      LEFT JOIN workspace_template_policies p ON p.template_id=c.id AND p.workspace_id=$1
      LEFT JOIN bindings i ON i.template_id=c.id AND i.workspace_id=$1
      LEFT JOIN LATERAL (
        SELECT r.manifest_json FROM template_revisions r WHERE r.template_id=c.id AND
          (CASE WHEN i.id IS NOT NULL THEN r.id=i.revision_id WHEN p.selected_revision_id IS NOT NULL THEN r.id=p.selected_revision_id ELSE r.state='published' END)
        ORDER BY r.published_at DESC NULLS LAST,r.created_at DESC,r.id DESC LIMIT 1
      ) revision ON TRUE
      LEFT JOIN docs d ON d.id=i.resolved_doc_id AND d.workspace_id=$1 AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root
      WHERE c.source='bundle' AND (p.id IS NOT NULL OR i.id IS NOT NULL) AND revision.manifest_json->>'purpose'='guide'
      ORDER BY c.slug
    "#
    );
    sqlx::query(&sql)
      .bind(workspace)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .into_iter()
      .map(|row| {
        Ok(ContextualGuideDelivery {
          slug: row.try_get("slug").map_err(Self::map_db_err)?,
          document_key: row.try_get("document_key").map_err(Self::map_db_err)?,
          document_id: row.try_get("document_id").map_err(Self::map_db_err)?,
          pending: row.try_get("pending").map_err(Self::map_db_err)?,
        })
      })
      .collect()
  }
}
