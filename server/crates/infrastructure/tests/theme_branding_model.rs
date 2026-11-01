// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for the server-owned theme model and brand-boundary model.

use myoxus_domain::repositories::PdfWorkspaceBrandAssetRepository;
use myoxus_infrastructure::branding::{bundled_font_family_count, bundled_theme_count, seed_system_theme_branding};
use myoxus_infrastructure::pdf_export::PgPdfWorkspaceBrandAssetRepository;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use uuid::Uuid;

static THEME_BRANDING_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

async fn theme_branding_guard() -> tokio::sync::MutexGuard<'static, ()> {
  THEME_BRANDING_TEST_LOCK.get_or_init(|| Mutex::new(())).lock().await
}

async fn setup_pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  PgPoolOptions::new()
    .max_connections(2)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(&url)
    .await
    .expect("test DB connection failed")
}

async fn cleanup_theme_branding(pool: &PgPool) {
  for stmt in [
    "DELETE FROM brand_identity_cutover_findings",
    "DELETE FROM document_brand_profiles",
    "DELETE FROM pdf_export_settings",
    "DELETE FROM app_server_branding",
    "DELETE FROM brand_assets",
    "DELETE FROM organization_identity",
    "DELETE FROM theme_profiles",
    "DELETE FROM branding_assets",
    "DELETE FROM branding_profiles",
    "DELETE FROM themes WHERE origin = 'system'",
    "DELETE FROM typography_styles WHERE typography_id IN (SELECT id FROM typography_sets WHERE origin = 'system')",
    "DELETE FROM typography_sets WHERE origin = 'system'",
    "DELETE FROM color_schema_values WHERE schema_id IN (SELECT id FROM color_schemas WHERE origin = 'system')",
    "DELETE FROM color_schemas WHERE origin = 'system'",
    "DELETE FROM font_assets WHERE family_id IN (SELECT id FROM font_families WHERE source = 'bundled')",
    "DELETE FROM font_families WHERE source = 'bundled'",
  ] {
    sqlx::query(stmt).execute(pool).await.ok();
  }
}

#[tokio::test]
async fn inv_theme_db_01_schema_and_seed_materialize_full_catalog() {
  let _guard = theme_branding_guard().await;
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  cleanup_theme_branding(&pool).await;

  let stats = seed_system_theme_branding(&pool)
    .await
    .expect("theme branding seed must succeed");
  assert_eq!(stats.font_families, bundled_font_family_count().expect("font count"));
  assert_eq!(stats.themes, bundled_theme_count().expect("theme count"));

  let font_families: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM font_families WHERE source = 'bundled'")
    .fetch_one(&pool)
    .await
    .expect("count font families");
  assert_eq!(font_families, 21, "all bundled font families must be imported");

  let themes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM themes WHERE origin = 'system'")
    .fetch_one(&pool)
    .await
    .expect("count themes");
  assert_eq!(themes, 16, "all 16 city themes must be imported");

  let missing_preview_metadata: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)
    FROM themes
    WHERE origin = 'system'
      AND (
        category IS NULL
        OR preview_group IS NULL
        OR preview_order <= 0
        OR tagline_key IS NULL
        OR description_key IS NULL
      )
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("count theme preview metadata");
  assert_eq!(
    missing_preview_metadata, 0,
    "system themes must carry Admin preview metadata from the server seed"
  );

  let preview_groups: i64 =
    sqlx::query_scalar("SELECT COUNT(DISTINCT preview_group) FROM themes WHERE origin = 'system'")
      .fetch_one(&pool)
      .await
      .expect("count theme preview groups");
  assert_eq!(
    preview_groups, 3,
    "the server seed must preserve the three audited Admin gallery groups"
  );

  let document_palettes: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)
    FROM document_theme_color_palettes p
    JOIN themes t ON t.id = p.theme_id
    WHERE t.origin = 'system'
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("count document palettes");
  assert_eq!(
    document_palettes,
    16 * 4,
    "every system theme must expose the reduced document color palettes"
  );

  let palette_default_violations: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)
    FROM (
      SELECT theme_id, COUNT(*) FILTER (WHERE is_default) AS defaults
      FROM document_theme_color_palettes
      GROUP BY theme_id
    ) p
    WHERE defaults != 1
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("count document palette default violations");
  assert_eq!(
    palette_default_violations, 0,
    "each theme must have exactly one default document palette"
  );

  let color_values: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM color_schema_values csv JOIN color_schemas cs ON cs.id = csv.schema_id WHERE cs.origin = 'system'",
  )
  .fetch_one(&pool)
  .await
  .expect("count color values");
  assert_eq!(
    color_values,
    16 * 2 * 18,
    "every city theme needs all light/dark color tokens"
  );

  let required_styles_missing: i64 = sqlx::query_scalar(
    r#"
    WITH required(style_key) AS (
      VALUES ('page.title'), ('section.title'), ('card.title'), ('modal.title'), ('body.default'),
             ('body.small'), ('quote.block'), ('code.inline'), ('code.block'),
             ('link.default'), ('label.compact'), ('pdf.heading'), ('pdf.body'),
             ('pdf.mono'), ('pdf.symbol')
    )
    SELECT COUNT(*)
    FROM typography_sets ts
    CROSS JOIN required r
    WHERE ts.origin = 'system'
      AND NOT EXISTS (
        SELECT 1 FROM typography_styles s
        WHERE s.typography_id = ts.id AND s.style_key = r.style_key
      )
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("count missing typography styles");
  assert_eq!(
    required_styles_missing, 0,
    "every system typography set must expose the required style keys"
  );

  let selectable_without_assets: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)
    FROM font_families ff
    WHERE ff.is_selectable = TRUE
      AND (
        NOT EXISTS (SELECT 1 FROM font_assets fa WHERE fa.family_id = ff.id AND fa.usage = 'web')
        OR NOT EXISTS (SELECT 1 FROM font_assets fa WHERE fa.family_id = ff.id AND fa.usage = 'pdf')
      )
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("selectable font invariant");
  assert_eq!(
    selectable_without_assets, 0,
    "selectable fonts require both web and PDF assets"
  );

  let boundary_singletons: Vec<(String, i64)> = sqlx::query(
    r#"
    SELECT 'organization_identity' AS name, COUNT(*)::bigint AS count FROM organization_identity
    UNION ALL SELECT 'app_server_branding', COUNT(*)::bigint FROM app_server_branding
    UNION ALL SELECT 'document_brand_profiles_global', COUNT(*)::bigint FROM document_brand_profiles WHERE scope = 'global'
    UNION ALL SELECT 'pdf_export_settings_global', COUNT(*)::bigint FROM pdf_export_settings WHERE scope = 'global'
    "#,
  )
  .fetch_all(&pool)
  .await
  .expect("count brand identity boundary singletons")
  .into_iter()
  .map(|row| (row.get::<String, _>("name"), row.get::<i64, _>("count")))
  .collect();
  for (name, count) in boundary_singletons {
    assert_eq!(count, 1, "{name} must have exactly one global row");
  }

  let duplicate_hash_groups: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM (SELECT sha256 FROM font_assets GROUP BY sha256 HAVING COUNT(*) > 1) d")
      .fetch_one(&pool)
      .await
      .expect("duplicate hash groups");
  assert!(
    duplicate_hash_groups > 0,
    "manifest contains legitimate duplicate hashes; font_assets.sha256 must not be globally unique"
  );

  cleanup_theme_branding(&pool).await;
}

#[tokio::test]
async fn inv_theme_db_02_seed_is_idempotent_and_pins_global_profile() {
  let _guard = theme_branding_guard().await;
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  cleanup_theme_branding(&pool).await;

  seed_system_theme_branding(&pool).await.expect("first seed");
  let before = count_catalog_rows(&pool).await;
  let timestamps_before = catalog_updated_at_snapshot(&pool).await;
  let second = seed_system_theme_branding(&pool).await.expect("second seed");
  assert_eq!(
    second.total_rows_materialized(),
    0,
    "second seed pass must report no inserts or updates"
  );
  assert_eq!(second.font_families, 0, "font families must be no-op on second seed");
  assert_eq!(second.font_assets, 0, "font assets must be no-op on second seed");
  assert_eq!(second.color_schemas, 0, "color schemas must be no-op on second seed");
  assert_eq!(second.color_values, 0, "color values must be no-op on second seed");
  assert_eq!(
    second.typography_sets, 0,
    "typography sets must be no-op on second seed"
  );
  assert_eq!(
    second.typography_styles, 0,
    "typography styles must be no-op on second seed"
  );
  assert_eq!(second.themes, 0, "themes must be no-op on second seed");
  assert!(
    !second.global_profile_created,
    "global profile must not be recreated on second seed"
  );
  let after = count_catalog_rows(&pool).await;
  let timestamps_after = catalog_updated_at_snapshot(&pool).await;
  assert_eq!(before, after, "seeding twice must not duplicate catalog rows");
  assert_eq!(
    timestamps_before, timestamps_after,
    "second seed pass must not rewrite updated_at timestamps"
  );

  let global_profiles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM theme_profiles WHERE scope = 'global'")
    .fetch_one(&pool)
    .await
    .expect("count global profiles");
  assert_eq!(global_profiles, 1, "seed must create exactly one global theme profile");

  let default_themes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM themes WHERE is_default = TRUE")
    .fetch_one(&pool)
    .await
    .expect("count default themes");
  assert_eq!(default_themes, 1, "seed must leave exactly one default theme");

  let pdf_role_violations: i64 = sqlx::query_scalar(
    r#"
    SELECT COUNT(*)
    FROM (
      SELECT typography_id, COUNT(*) FILTER (WHERE pdf_role IS NOT NULL) AS role_count,
             COUNT(DISTINCT pdf_role) FILTER (WHERE pdf_role IS NOT NULL) AS distinct_role_count
      FROM typography_styles
      GROUP BY typography_id
    ) t
    WHERE role_count != 4 OR distinct_role_count != 4
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("pdf role invariant");
  assert_eq!(
    pdf_role_violations, 0,
    "each typography set must expose exactly four unique PDF roles"
  );

  cleanup_theme_branding(&pool).await;
}

#[tokio::test]
async fn inv_theme_db_02b_concurrent_first_seed_serializes_without_partial_failure() {
  let _guard = theme_branding_guard().await;
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  cleanup_theme_branding(&pool).await;

  let (first, second) = tokio::join!(seed_system_theme_branding(&pool), seed_system_theme_branding(&pool));
  let first = first.expect("first concurrent seed");
  let second = second.expect("second concurrent seed");

  let materialized = [first.total_rows_materialized(), second.total_rows_materialized()];
  assert!(
    materialized.iter().any(|count| *count > 0),
    "one startup must materialize the bundled catalog"
  );
  assert_eq!(
    materialized.iter().filter(|count| **count == 0).count(),
    1,
    "the startup that acquires the seed lock second must observe a complete no-op catalog"
  );

  let rows = count_catalog_rows(&pool).await;
  assert!(
    rows.iter().all(|(_, count)| *count > 0),
    "concurrent startup must leave every catalog projection materialized"
  );

  cleanup_theme_branding(&pool).await;
}

#[tokio::test]
async fn inv_theme_db_03_stuttgart_only_inherits_zuerich_background_tokens() {
  let _guard = theme_branding_guard().await;
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  cleanup_theme_branding(&pool).await;
  seed_system_theme_branding(&pool).await.expect("seed");

  for (mode, paper, paper_deep) in [("light", "#ffffff", "#f3f3f5"), ("dark", "#08090c", "#11131a")] {
    assert_eq!(theme_color_value(&pool, "stuttgart", mode, "paper").await, paper);
    assert_eq!(
      theme_color_value(&pool, "stuttgart", mode, "paper-deep").await,
      paper_deep
    );
    assert_eq!(
      theme_color_value(&pool, "zuerich", mode, "paper").await,
      paper,
      "the Stuttgart background transfer is intentionally sourced from Zuerich"
    );
    assert_eq!(
      theme_color_value(&pool, "zuerich", mode, "paper-deep").await,
      paper_deep,
      "the Stuttgart background transfer is intentionally sourced from Zuerich"
    );
    assert_ne!(
      theme_color_value(&pool, "stuttgart", mode, "rule").await,
      theme_color_value(&pool, "zuerich", mode, "rule").await,
      "border/rule tokens must remain Stuttgart-specific"
    );
    assert_ne!(
      theme_color_value(&pool, "stuttgart", mode, "accent-primary").await,
      theme_color_value(&pool, "zuerich", mode, "accent-primary").await,
      "accent tokens must remain Stuttgart-specific"
    );
  }

  let (stuttgart_color_schema, stuttgart_typography): (String, String) = sqlx::query_as(
    r#"
    SELECT cs.slug AS color_schema, ts.slug AS typography
    FROM themes t
    JOIN color_schemas cs ON cs.id = t.color_schema_id
    JOIN typography_sets ts ON ts.id = t.typography_id
    WHERE t.slug = 'stuttgart'
    "#,
  )
  .fetch_one(&pool)
  .await
  .expect("load Stuttgart theme links");
  assert_eq!(stuttgart_color_schema, "stuttgart");
  assert_eq!(
    stuttgart_typography, "stuttgart",
    "background transfer must not turn Stuttgart into a Zuerich typography preset"
  );

  cleanup_theme_branding(&pool).await;
}

#[tokio::test]
async fn inv_brand_identity_01_pdf_projection_inherits_global_document_branding_and_settings() {
  let _guard = theme_branding_guard().await;
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  cleanup_theme_branding(&pool).await;
  seed_system_theme_branding(&pool).await.expect("seed");

  sqlx::query(
    r#"
    UPDATE organization_identity
    SET display_name = 'Global Document Org'
    WHERE id = TRUE
    "#,
  )
  .execute(&pool)
  .await
  .expect("set global org identity");
  sqlx::query(
    r#"
    UPDATE document_brand_profiles
    SET footer_text = 'Global footer',
        color_policy = 'custom',
        color_palette_key = NULL,
        custom_primary_color = '#112233',
        custom_accent_color = '#445566'
    WHERE scope = 'global'
    "#,
  )
  .execute(&pool)
  .await
  .expect("set global document branding");
  sqlx::query(
    r#"
    UPDATE pdf_export_settings
    SET default_paper_size = 'A5',
        default_locale = 'fr',
        default_image_quality = 'lossless',
        ligatures_enabled = FALSE
    WHERE scope = 'global'
    "#,
  )
  .execute(&pool)
  .await
  .expect("set global pdf settings");

  let workspace_id = Uuid::new_v4();
  let projection = PgPdfWorkspaceBrandAssetRepository::new(pool.clone())
    .get(workspace_id)
    .await
    .expect("load effective pdf projection")
    .expect("projection row");

  assert_eq!(projection.workspace_id, workspace_id);
  assert_eq!(
    projection.company_name.as_deref(),
    Some("Global Document Org"),
    "document render projection must inherit global organisation identity"
  );
  assert_eq!(
    projection.footer_text.as_deref(),
    Some("Global footer"),
    "document render projection must inherit global document footer"
  );
  assert_eq!(
    projection.brand_color_primary.as_deref(),
    Some("#112233"),
    "custom document primary color must come from document branding, not PDF settings"
  );
  assert_eq!(projection.default_locale.as_deref(), Some("fr"));
  assert_eq!(projection.default_paper_size.as_deref(), Some("A5"));
  assert_eq!(projection.default_image_quality.as_deref(), Some("lossless"));
  assert!(
    !projection.ligatures_enabled,
    "ligature default must come from pdf_export_settings"
  );

  cleanup_theme_branding(&pool).await;
}

#[tokio::test]
async fn inv_brand_identity_02_legacy_workspace_company_names_do_not_override_global_org() {
  let _guard = theme_branding_guard().await;
  let pool = setup_pool().await;
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  cleanup_theme_branding(&pool).await;
  seed_system_theme_branding(&pool).await.expect("seed");

  let default_theme_id: Uuid = sqlx::query_scalar("SELECT id FROM themes WHERE is_default = TRUE LIMIT 1")
    .fetch_one(&pool)
    .await
    .expect("default theme id");
  sqlx::query("UPDATE organization_identity SET display_name = 'Global Legal Org' WHERE id = TRUE")
    .execute(&pool)
    .await
    .expect("set global organisation");

  let owner_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Theme Boundary Owner')")
    .bind(owner_id)
    .bind(format!("theme-boundary-{owner_id}@example.invalid"))
    .execute(&pool)
    .await
    .expect("insert owner");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Theme Boundary Workspace')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("insert workspace");
  sqlx::query(
    r#"
    INSERT INTO branding_profiles
      (scope, workspace_id, theme_id, theme_mode, company_name)
    VALUES ('workspace', $1, $2, 'system', 'Rogue Workspace Org')
    "#,
  )
  .bind(workspace_id)
  .bind(default_theme_id)
  .execute(&pool)
  .await
  .expect("insert legacy workspace company_name");

  let projection = PgPdfWorkspaceBrandAssetRepository::new(pool.clone())
    .get(workspace_id)
    .await
    .expect("load effective pdf projection")
    .expect("projection row");

  assert_eq!(
    projection.company_name.as_deref(),
    Some("Global Legal Org"),
    "legacy workspace company_name must never become a workspace organisation override"
  );
  assert_ne!(
    projection.company_name.as_deref(),
    Some("Rogue Workspace Org"),
    "the final brand model has no workspace-scoped organisation name"
  );

  cleanup_theme_branding(&pool).await;
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .ok();
}

async fn theme_color_value(pool: &PgPool, theme_slug: &str, mode: &str, token_key: &str) -> String {
  sqlx::query_scalar(
    r#"
    SELECT csv.value
    FROM themes t
    JOIN color_schemas cs ON cs.id = t.color_schema_id
    JOIN color_schema_values csv ON csv.schema_id = cs.id
    WHERE t.slug = $1 AND csv.mode = $2 AND csv.token_key = $3
    "#,
  )
  .bind(theme_slug)
  .bind(mode)
  .bind(token_key)
  .fetch_one(pool)
  .await
  .expect("theme color token")
}

async fn count_catalog_rows(pool: &PgPool) -> Vec<(String, i64)> {
  let rows = sqlx::query(
    r#"
    SELECT 'font_families' AS name, COUNT(*)::bigint AS count FROM font_families WHERE source = 'bundled'
    UNION ALL SELECT 'font_assets', COUNT(*)::bigint FROM font_assets fa JOIN font_families ff ON ff.id = fa.family_id WHERE ff.source = 'bundled'
    UNION ALL SELECT 'color_schemas', COUNT(*)::bigint FROM color_schemas WHERE origin = 'system'
    UNION ALL SELECT 'color_schema_values', COUNT(*)::bigint FROM color_schema_values csv JOIN color_schemas cs ON cs.id = csv.schema_id WHERE cs.origin = 'system'
    UNION ALL SELECT 'typography_sets', COUNT(*)::bigint FROM typography_sets WHERE origin = 'system'
    UNION ALL SELECT 'typography_styles', COUNT(*)::bigint FROM typography_styles ts JOIN typography_sets t ON t.id = ts.typography_id WHERE t.origin = 'system'
    UNION ALL SELECT 'themes', COUNT(*)::bigint FROM themes WHERE origin = 'system'
    UNION ALL SELECT 'theme_profiles', COUNT(*)::bigint FROM theme_profiles WHERE scope = 'global'
    ORDER BY name
    "#,
  )
  .fetch_all(pool)
  .await
  .expect("count catalog rows");
  rows
    .into_iter()
    .map(|row| (row.get::<String, _>("name"), row.get::<i64, _>("count")))
    .collect()
}

async fn catalog_updated_at_snapshot(pool: &PgPool) -> Vec<(String, String, String)> {
  let rows = sqlx::query(
    r#"
    SELECT 'font_families' AS table_name, slug AS key, updated_at::text AS updated_at
    FROM font_families WHERE source = 'bundled'
    UNION ALL
    SELECT 'color_schemas', slug, updated_at::text
    FROM color_schemas WHERE origin = 'system'
    UNION ALL
    SELECT 'typography_sets', slug, updated_at::text
    FROM typography_sets WHERE origin = 'system'
    UNION ALL
    SELECT 'themes', slug, updated_at::text
    FROM themes WHERE origin = 'system'
    UNION ALL
    SELECT 'theme_profiles', scope || ':' || COALESCE(workspace_id::text, 'global'), updated_at::text
    FROM theme_profiles WHERE scope = 'global'
    ORDER BY table_name, key
    "#,
  )
  .fetch_all(pool)
  .await
  .expect("updated_at snapshot");
  rows
    .into_iter()
    .map(|row| {
      (
        row.get::<String, _>("table_name"),
        row.get::<String, _>("key"),
        row.get::<String, _>("updated_at"),
      )
    })
    .collect()
}
