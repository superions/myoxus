// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only Library inventory and exact source lookup through the Registry store.

use myoxus_application::{
  auth::{AuthError, AuthResult},
  template_registry::{
    bundle::TitlePolicy,
    suggestions::{
      TemplateLibraryKind, TemplateLibraryOrigin, TemplateLibraryQuery, TemplateLibrarySort, TemplateLibrarySource,
    },
  },
};
use sqlx::Row;
use tracing::instrument;

use super::SqlxTemplateRegistryStore;
use crate::document_metadata::NATIVE_TEMPLATE_SOURCE_PREDICATE;

impl SqlxTemplateRegistryStore {
  #[instrument(skip_all, fields(workspace_id = %query.workspace_id, limit = query.limit))]
  pub(super) async fn read_library_sources(
    &self,
    query: &TemplateLibraryQuery,
  ) -> AuthResult<Vec<TemplateLibrarySource>> {
    if !(1..=201).contains(&query.limit) {
      return Err(AuthError::InvalidInput("invalid Library page size".into()));
    }
    // Only fixed identifiers enter SQL. Labels follow the materialized content
    // locale; the interface locale selects ordering, never another source body.
    let collation = match query
      .locale
      .split(['-', '_'])
      .next()
      .unwrap_or_default()
      .to_ascii_lowercase()
      .as_str()
    {
      "de" => "de-x-icu",
      "fr" => "fr-x-icu",
      "es" => "es-x-icu",
      "en" => "en-x-icu",
      _ => "und-x-icu",
    };
    let (order, continuation) = match query.filter.sort {
      TemplateLibrarySort::NameAsc => (
        format!("lower(title) COLLATE \"{collation}\" ASC, key ASC"),
        format!(
          "lower(title) COLLATE \"{collation}\" > lower($7::text) COLLATE \"{collation}\" OR (lower(title) COLLATE \"{collation}\" = lower($7::text) COLLATE \"{collation}\" AND key > $9)"
        ),
      ),
      TemplateLibrarySort::NameDesc => (
        format!("lower(title) COLLATE \"{collation}\" DESC, key ASC"),
        format!(
          "lower(title) COLLATE \"{collation}\" < lower($7::text) COLLATE \"{collation}\" OR (lower(title) COLLATE \"{collation}\" = lower($7::text) COLLATE \"{collation}\" AND key > $9)"
        ),
      ),
      TemplateLibrarySort::UpdatedDesc => (
        "updated_at DESC, key ASC".into(),
        "updated_at < $8::timestamptz OR (updated_at = $8::timestamptz AND key > $9)".into(),
      ),
      TemplateLibrarySort::UpdatedAsc => (
        "updated_at ASC, key ASC".into(),
        "updated_at > $8::timestamptz OR (updated_at = $8::timestamptz AND key > $9)".into(),
      ),
    };
    let sql = format!(
      r#"
      WITH page_cursor AS (
        SELECT $7::text AS cursor_title, $8::timestamptz AS cursor_updated_at, $9::text AS cursor_key
      ), assigned AS (
        SELECT 'registry:' || p.id::text AS key, c.id::text AS template_id,
          CASE WHEN {NATIVE_TEMPLATE_SOURCE_PREDICATE}
            AND (c.source='builtin' OR applied.state IN ('published','deprecated'))
            THEN d.external_id END AS document_key,
          COALESCE(d.external_id,i.workspace_doc_key) AS lookup_key,
          c.slug, c.title AS catalog_title, c.description AS catalog_description,
          c.source, GREATEST(c.updated_at,d.updated_at,template.updated_at) AS updated_at,
          c.category, c.tags, i.state AS instance_state, c.min_client_version,
          p.provisioning_mode IN ('managed_until_local_edit','manual_update') AS protected_source,
          COALESCE(applied.id,target.id) AS revision_id,
          CASE WHEN applied.id IS NOT NULL THEN applied.manifest_json ELSE target.manifest END AS manifest,
          i.locale_hash
        FROM workspace_template_policies p
        JOIN template_catalog_entries c ON c.id=p.template_id AND c.status='active'
        LEFT JOIN workspace_template_instances i ON i.workspace_id=p.workspace_id AND i.template_id=c.id
        LEFT JOIN docs exact_doc ON $2::text IS NOT NULL AND exact_doc.workspace_id=$1 AND exact_doc.external_id=$2
        LEFT JOIN LATERAL (
          SELECT source.id, source.external_id, source.updated_at, source.deleted_at, source.blocked, source.is_workspace_root
          FROM docs source
          WHERE source.workspace_id=p.workspace_id AND (
            (i.workspace_doc_key IS NOT NULL AND (source.external_id=i.workspace_doc_key OR source.id::text=i.workspace_doc_key))
            OR (i.workspace_doc_key IS NULL AND source.id=i.workspace_doc_id))
          ORDER BY (source.external_id=i.workspace_doc_key) DESC NULLS LAST, source.id
          LIMIT 1
        ) d ON TRUE
        LEFT JOIN document_template_state template ON template.doc_id=d.id
        LEFT JOIN template_revisions applied ON applied.id=i.revision_id AND applied.template_id=c.id
        LEFT JOIN LATERAL (
          SELECT r.id,r.state,r.manifest_json AS manifest FROM template_revisions r
          WHERE r.template_id=c.id AND (
            (p.selection_mode='pinned_revision' AND r.id=p.selected_revision_id AND r.state IN ('published','deprecated'))
            OR (p.selection_mode='published' AND r.state='published'))
          ORDER BY r.published_at DESC NULLS LAST,r.created_at DESC,r.id DESC LIMIT 1
        ) target ON c.source='bundle'
        WHERE p.workspace_id=$1 AND p.is_enabled
          AND (i.id IS NULL OR (i.state<>'retired' AND i.retired_at IS NULL))
          AND (c.source='builtin' OR target.id IS NOT NULL)
          AND NOT (c.source='builtin' AND c.category IS NOT DISTINCT FROM 'onboarding')
          AND COALESCE(target.manifest->>'purpose','template')<>'guide'
          AND COALESCE(applied.manifest_json->>'purpose','template')<>'guide'
          AND ($2::text IS NULL OR i.workspace_doc_key=$2 OR i.workspace_doc_id=exact_doc.id OR i.workspace_doc_key=exact_doc.id::text)
      ), inventory AS (
        SELECT key,template_id,document_key,lookup_key,slug,
          COALESCE(manifest->'localized_contents'->source_locale.locale->>'title',manifest->>'title',catalog_title) AS title,
          CASE WHEN manifest->'localized_contents' ? source_locale.locale
            THEN manifest->'localized_contents'->source_locale.locale->>'description'
            ELSE COALESCE(manifest->>'description',catalog_description) END AS description,
          source,updated_at,category,tags,instance_state,min_client_version,protected_source,revision_id,
          COALESCE(manifest->>'title_policy','template') AS title_policy
        FROM assigned
        LEFT JOIN LATERAL (
          SELECT candidate.locale FROM (
            SELECT key AS locale,0 AS kind FROM jsonb_object_keys(
              CASE WHEN jsonb_typeof(manifest->'localized_contents')='object'
                THEN manifest->'localized_contents' ELSE '{{}}'::jsonb END) key
            UNION ALL SELECT manifest->>'locale',1
          ) candidate
          WHERE lower(replace(candidate.locale,'_','-')) IN (
              lower(replace(locale_hash,'_','-')),split_part(lower(replace(locale_hash,'_','-')),'-',1))
            OR candidate.locale=manifest->>'locale'
          ORDER BY CASE
            WHEN lower(replace(candidate.locale,'_','-'))=lower(replace(locale_hash,'_','-')) THEN 0
            WHEN lower(replace(candidate.locale,'_','-'))=split_part(lower(replace(locale_hash,'_','-')),'-',1) THEN 1
            ELSE 2 END,candidate.kind,candidate.locale LIMIT 1
        ) source_locale ON TRUE
        UNION ALL
        SELECT 'document:' || d.id::text,d.external_id,d.external_id,d.external_id,d.external_id,d.title,NULL,
          CASE WHEN template.metadata->>'origin'='custom' THEN 'custom' ELSE 'unknown' END,
          GREATEST(d.updated_at,template.updated_at),template.metadata->>'category',
          ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(template.metadata->'tags')='array' THEN template.metadata->'tags' ELSE '[]'::jsonb END)),
          NULL::text,0,FALSE,NULL::uuid,'template'
        FROM docs d JOIN document_template_state template ON template.doc_id=d.id
        WHERE d.workspace_id=$1 AND {NATIVE_TEMPLATE_SOURCE_PREDICATE}
          AND ($2::text IS NULL OR d.external_id=$2)
          AND NOT EXISTS (
            SELECT 1 FROM workspace_template_instances bound
            WHERE bound.workspace_id=$1 AND ((bound.workspace_doc_key IS NULL AND bound.workspace_doc_id=d.id) OR bound.workspace_doc_key=d.external_id
              OR (bound.workspace_doc_key=d.id::text AND NOT EXISTS (
                SELECT 1 FROM docs preferred WHERE preferred.workspace_id=$1 AND preferred.external_id=bound.workspace_doc_key))))
      ), unique_sources AS (
        SELECT DISTINCT ON (COALESCE(lookup_key,key)) * FROM inventory
        ORDER BY COALESCE(lookup_key,key),key
      )
      SELECT key,template_id,document_key,slug,title,description,source,updated_at,category,tags,
        instance_state,min_client_version,protected_source,revision_id,title_policy
      FROM unique_sources CROSS JOIN page_cursor
      WHERE ($2::text IS NULL OR lookup_key=$2)
        AND ($3::text IS NULL OR (($3='building-block') = (category IS NOT DISTINCT FROM 'building-blocks')))
        AND ($4::text IS NULL OR position(lower($4) in lower(title || E'\n' || COALESCE(description,''))) > 0)
        AND ($5::text IS NULL OR source=$5)
        AND ($6::text IS NULL OR $6=ANY(tags))
        AND ($9::text IS NULL OR ({continuation}))
      ORDER BY {order}
      LIMIT $10
    "#
    );
    let rows = sqlx::query(&sql)
      .bind(query.workspace_id)
      .bind(&query.filter.source_doc_id)
      .bind(query.filter.kind.map(|kind| match kind {
        TemplateLibraryKind::Document => "document",
        TemplateLibraryKind::BuildingBlock => "building-block",
      }))
      .bind(&query.filter.search)
      .bind(query.filter.origin.map(|origin| match origin {
        TemplateLibraryOrigin::Builtin => "builtin",
        TemplateLibraryOrigin::Imported => "bundle",
        TemplateLibraryOrigin::Custom => "custom",
        TemplateLibraryOrigin::Unknown => "unknown",
      }))
      .bind(&query.filter.work_area_tag)
      .bind(query.after.as_ref().map(|cursor| &cursor.title))
      .bind(query.after.as_ref().map(|cursor| cursor.updated_at))
      .bind(query.after.as_ref().map(|cursor| &cursor.key))
      .bind(query.limit as i64)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    rows
      .into_iter()
      .map(|row| {
        let policy: Option<String> = row.try_get("title_policy").map_err(Self::map_db_err)?;
        let title_policy = match policy.as_deref() {
          None | Some("template") => Some(TitlePolicy::Template),
          Some("template-date") => Some(TitlePolicy::TemplateDate),
          Some("date") => Some(TitlePolicy::Date),
          Some(_) => return Err(AuthError::Storage("invalid source title policy".into())),
        };
        let state: Option<String> = row.try_get("instance_state").map_err(Self::map_db_err)?;
        Ok(TemplateLibrarySource {
          key: row.try_get("key").map_err(Self::map_db_err)?,
          template_id: row.try_get("template_id").map_err(Self::map_db_err)?,
          document_key: row.try_get("document_key").map_err(Self::map_db_err)?,
          slug: row.try_get("slug").map_err(Self::map_db_err)?,
          title: row.try_get("title").map_err(Self::map_db_err)?,
          description: row.try_get("description").map_err(Self::map_db_err)?,
          source: row.try_get("source").map_err(Self::map_db_err)?,
          updated_at: row.try_get("updated_at").map_err(Self::map_db_err)?,
          category: row.try_get("category").map_err(Self::map_db_err)?,
          tags: row.try_get("tags").map_err(Self::map_db_err)?,
          title_policy,
          revision_id: row.try_get("revision_id").map_err(Self::map_db_err)?,
          instance_state: state.as_deref().map(super::instance_state_from_db).transpose()?,
          min_client_version: row
            .try_get::<i32, _>("min_client_version")
            .map_err(Self::map_db_err)?
            .max(0) as u32,
          protected_source: row.try_get("protected_source").map_err(Self::map_db_err)?,
        })
      })
      .collect()
  }
}
