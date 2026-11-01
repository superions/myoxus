// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration gates for the server-owned theme model.
//!
//! These tests intentionally exercise the public HTTP runtime CSS, the font
//! discovery endpoint and AdminRoot GraphQL in one flow so drift back to
//! static client presets is visible at the API boundary.

use serde_json::json;
use uuid::Uuid;

use crate::helpers;

const ADMIN_THEME_BRANDING_GQL: &str =
  include_str!("../../../../../client/libs/graphql/src/graphql/admin/theme-branding.gql");

#[test]
fn inv_theme_db_api_01_admin_catalog_runtime_css_and_fonts_use_typed_model() {
  helpers::block_on_large_stack("inv-theme-db-api-01", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;

    let catalog = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        query {
          admin {
            themeCatalog {
              catalogHash
              themes {
                slug
                category
                previewGroup
                previewOrder
                taglineKey
                descriptionKey
                isDefault
                colors
                typographyStyles { styleKey pdfRole fontFamily fontWeight }
              }
              fontFamilies {
                slug
                isSelectable
                assets { usage format assetKey sha256 }
              }
            }
            effectiveThemeProfile {
              themeMode
              theme { slug typographyStyles { styleKey pdfRole } }
            }
          }
        }
      "#,
      }),
    )
    .await;
    assert!(catalog.get("errors").is_none(), "catalog query failed: {catalog}");

    let themes = catalog["data"]["admin"]["themeCatalog"]["themes"]
      .as_array()
      .expect("themes");
    assert_eq!(themes.len(), 16, "all city themes must be exposed through AdminRoot");
    assert!(
      themes
        .iter()
        .any(|theme| theme["slug"] == "stuttgart" && theme["isDefault"] == true),
      "stuttgart must remain the seeded default theme"
    );
    let stuttgart = themes
      .iter()
      .find(|theme| theme["slug"] == "stuttgart")
      .expect("stuttgart theme");
    assert_eq!(stuttgart["category"], "sans-leaning");
    assert_eq!(stuttgart["previewGroup"], "sans-foundations");
    assert_eq!(stuttgart["previewOrder"], 1);
    assert_eq!(stuttgart["taglineKey"], "admin.design.theme.stuttgart.tagline");
    assert_eq!(stuttgart["descriptionKey"], "admin.design.theme.stuttgart.description");
    let fonts = catalog["data"]["admin"]["themeCatalog"]["fontFamilies"]
      .as_array()
      .expect("fonts");
    assert!(
      fonts.iter().any(|font| {
        font["isSelectable"] == true
          && font["assets"].as_array().is_some_and(|assets| {
            assets
              .iter()
              .any(|asset| asset["usage"] == "web" && asset["format"] == "woff2")
          })
          && font["assets"]
            .as_array()
            .is_some_and(|assets| assets.iter().any(|asset| asset["usage"] == "pdf"))
      }),
      "selectable fonts must expose both web and PDF assets"
    );

    let mutation = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        mutation SetTheme($input: SetThemeProfileInput!) {
          admin {
            setThemeProfile(input: $input) {
              themeMode
              theme { slug }
            }
          }
        }
      "#,
        "variables": {
          "input": { "themeSlug": "hamburg", "themeMode": "dark" }
        }
      }),
    )
    .await;
    assert!(mutation.get("errors").is_none(), "setThemeProfile failed: {mutation}");
    assert_eq!(mutation["data"]["admin"]["setThemeProfile"]["theme"]["slug"], "hamburg");

    let (status, css_body) = helpers::get_raw(&app, "/api/branding/theme.css").await;
    assert_eq!(status, 200, "runtime CSS must be available");
    let css = String::from_utf8_lossy(&css_body);
    for needle in [
      "--myoxus-typography-h1-family:",
      "--myoxus-typography-section-title-family:",
      "--myoxus-typography-card-title-family:",
      "--myoxus-typography-card-title-letter-spacing:",
      "--myoxus-typography-modal-title-size:",
      "--myoxus-typography-label-compact-size:",
      "--myoxus-typography-code-block-family:",
      "--myoxus-background-code-block:",
      "--myoxus-sem-surface-elevated:",
      "--myoxus-background-overlay-panel-color:",
      "@font-face",
    ] {
      assert!(css.contains(needle), "runtime CSS missing `{needle}`\n----\n{css}");
    }
    assert!(
      !css.contains("--myoxus-sem-background-code-block"),
      "runtime CSS must expose only the canonical code background variable"
    );

    sqlx::query(
      r#"
      WITH asset AS (
        INSERT INTO brand_assets (
          scope, slot, variant, quality_class, storage_kind, storage_key,
          public_path, mime, sha256, created_by
        )
        VALUES (
          'global', 'logo', 'large', 'web', 'style_static', 'logo.svg',
          '/style/logo.svg', 'image/svg+xml', 'abcdef012345', $1
        )
        ON CONFLICT (slot, variant, quality_class) WHERE scope = 'global'
        DO UPDATE SET
          storage_key = EXCLUDED.storage_key,
          public_path = EXCLUDED.public_path,
          mime = EXCLUDED.mime,
          sha256 = EXCLUDED.sha256,
          created_by = EXCLUDED.created_by,
          updated_at = now()
        RETURNING id
      )
      UPDATE app_server_branding
      SET logo_asset_id = (SELECT id FROM asset), updated_by = $1, updated_at = now()
      WHERE id = TRUE
      "#,
    )
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("seed typed app/server brand asset");

    let profile = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        query {
          admin {
            appServerBranding {
              logo { slot variant storageKey mime sha256 publicUrl }
            }
          }
        }
      "#,
      }),
    )
    .await;
    assert!(
      profile.get("errors").is_none(),
      "app/server branding query failed: {profile}"
    );
    let logo = &profile["data"]["admin"]["appServerBranding"]["logo"];
    assert!(
      logo["slot"] == "logo"
        && logo["variant"] == "large"
        && logo["storageKey"] == "logo.svg"
        && logo["publicUrl"] == "/style/logo.svg?v=abcdef012345"
        && logo["sha256"] == "abcdef012345",
      "app/server branding must expose typed brand asset, got {logo:?}"
    );

    let (status, font_body) = helpers::get_raw(&app, "/api/fonts").await;
    assert_eq!(status, 200, "font endpoint must be available");
    let font_json: serde_json::Value = serde_json::from_slice(&font_body).expect("font json");
    let font_rows = font_json.as_array().expect("font list");
    assert!(
      font_rows.iter().any(|font| {
        font["url"]
          .as_str()
          .is_some_and(|url| url.starts_with("/api/fonts/") && url.contains("?v="))
      }),
      "font endpoint must expose cache-busted server font URLs"
    );

    sqlx::query("DELETE FROM brand_assets WHERE sha256 = 'abcdef012345'")
      .execute(&pool)
      .await
      .ok();
    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_theme_db_api_02_generated_admin_operations_match_server_schema() {
  helpers::block_on_large_stack("inv-theme-db-api-02", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;

    for operation_name in ["adminThemeCatalog", "adminEffectiveThemeProfile"] {
      let response = helpers::gql(
        &app,
        session_id,
        json!({
          "query": ADMIN_THEME_BRANDING_GQL,
          "operationName": operation_name,
          "variables": { "workspaceId": null }
        }),
      )
      .await;
      assert!(
        response.get("errors").is_none(),
        "{operation_name} generated operation must execute against server schema: {response}"
      );
    }

    let mutation = helpers::gql(
      &app,
      session_id,
      json!({
        "query": ADMIN_THEME_BRANDING_GQL,
        "operationName": "adminSetThemeProfile",
        "variables": {
          "input": { "themeSlug": "hamburg", "themeMode": "dark" }
        }
      }),
    )
    .await;
    assert!(
      mutation.get("errors").is_none(),
      "adminSetThemeProfile generated operation must execute against server schema: {mutation}"
    );
    assert_eq!(mutation["data"]["admin"]["setThemeProfile"]["theme"]["slug"], "hamburg");

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme");

    let typography = helpers::gql(
      &app,
      session_id,
      json!({
        "query": ADMIN_THEME_BRANDING_GQL,
        "operationName": "adminSetTypographyStyles",
        "variables": {
          "typographyInput": {
            "styles": [
              {
                "styleKey": "body.default",
                "fontFamilySlug": "lora",
                "fontWeight": 400,
                "fontStyle": "normal",
                "sizePx": 17,
                "lineHeight": 1.65
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      typography.get("errors").is_none(),
      "adminSetTypographyStyles generated operation must execute against server schema: {typography}"
    );
    let theme_slug = typography["data"]["admin"]["setTypographyStyles"]["theme"]["slug"]
      .as_str()
      .expect("clone theme slug")
      .to_string();
    let typography_slug = typography["data"]["admin"]["setTypographyStyles"]["theme"]["typographySlug"]
      .as_str()
      .expect("clone typography slug")
      .to_string();
    assert!(
      theme_slug.contains("typography"),
      "system theme must be clone-on-write for typography edits, got {theme_slug}"
    );
    let styles = typography["data"]["admin"]["setTypographyStyles"]["theme"]["typographyStyles"]
      .as_array()
      .expect("updated typography styles");
    assert!(
      styles.iter().any(|style| {
        style["styleKey"] == "body.default"
          && style["fontFamilySlug"] == "lora"
          && style["fontWeight"] == 400
          && style["sizePx"] == 17.0
      }),
      "body.default style was not updated through typed AdminRoot mutation: {styles:?}"
    );

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme after typography edit");
    sqlx::query("DELETE FROM themes WHERE slug = $1")
      .bind(&theme_slug)
      .execute(&pool)
      .await
      .expect("delete cloned typography theme");
    sqlx::query(
      "DELETE FROM typography_styles WHERE typography_id IN (SELECT id FROM typography_sets WHERE slug = $1)",
    )
    .bind(&typography_slug)
    .execute(&pool)
    .await
    .expect("delete cloned typography styles");
    sqlx::query("DELETE FROM typography_sets WHERE slug = $1")
      .bind(&typography_slug)
      .execute(&pool)
      .await
      .expect("delete cloned typography set");

    let colors = helpers::gql(
      &app,
      session_id,
      json!({
        "query": ADMIN_THEME_BRANDING_GQL,
        "operationName": "adminSetColorSchemaValues",
        "variables": {
          "colorInput": {
            "colors": [
              {
                "mode": "light",
                "tokenKey": "accent-primary",
                "value": "#123456"
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      colors.get("errors").is_none(),
      "adminSetColorSchemaValues generated operation must execute against server schema: {colors}"
    );
    let color_theme_slug = colors["data"]["admin"]["setColorSchemaValues"]["theme"]["slug"]
      .as_str()
      .expect("color clone theme slug")
      .to_string();
    let color_schema_slug = colors["data"]["admin"]["setColorSchemaValues"]["theme"]["colorSchemaSlug"]
      .as_str()
      .expect("color clone schema slug")
      .to_string();
    assert!(
      color_theme_slug.contains("colors"),
      "system theme must be clone-on-write for color edits, got {color_theme_slug}"
    );
    assert_eq!(
      colors["data"]["admin"]["setColorSchemaValues"]["theme"]["colors"]["light"]["accent-primary"],
      "#123456"
    );

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme after color edit");
    sqlx::query("DELETE FROM themes WHERE slug = $1")
      .bind(&color_theme_slug)
      .execute(&pool)
      .await
      .expect("delete cloned color theme");
    sqlx::query("DELETE FROM color_schema_values WHERE schema_id IN (SELECT id FROM color_schemas WHERE slug = $1)")
      .bind(&color_schema_slug)
      .execute(&pool)
      .await
      .expect("delete cloned color values");
    sqlx::query("DELETE FROM color_schemas WHERE slug = $1")
      .bind(&color_schema_slug)
      .execute(&pool)
      .await
      .expect("delete cloned color schema");

    let reset_workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let reset = helpers::gql(
      &app,
      session_id,
      json!({
        "query": ADMIN_THEME_BRANDING_GQL,
        "operationName": "adminResetWorkspaceThemeProfile",
        "variables": {
          "resetInput": { "workspaceId": reset_workspace_id.to_string() }
        }
      }),
    )
    .await;
    assert!(
      reset.get("errors").is_none(),
      "adminResetWorkspaceThemeProfile generated operation must execute against server schema: {reset}"
    );
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
      .bind(reset_workspace_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(reset_workspace_id)
      .execute(&pool)
      .await
      .ok();
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_theme_db_api_03_typography_mutation_validates_fonts_and_clone_on_write() {
  helpers::block_on_large_stack("inv-theme-db-api-03", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;

    let invalid = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation InvalidTypography($input: SetTypographyStylesInput!) {
            admin {
              setTypographyStyles(input: $input) {
                theme { slug }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "styles": [
              {
                "styleKey": "pdf.body",
                "fontFamilySlug": "bebas-neue",
                "fontWeight": 500,
                "fontStyle": "normal"
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      invalid
        .get("errors")
        .and_then(|errors| errors.as_array())
        .is_some_and(|errors| {
          errors.iter().any(|error| {
            error["message"]
              .as_str()
              .is_some_and(|message| message.contains("does not provide web asset"))
          })
        }),
      "unsupported font weight must fail before typography is persisted: {invalid}"
    );

    let valid = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation UpdateTypography($input: SetTypographyStylesInput!) {
            admin {
              setTypographyStyles(input: $input) {
                theme {
                  slug
                  origin
                  locked
                  typographySlug
                  typographyStyles {
                    styleKey
                    fontFamilySlug
                    fontWeight
                    sizePx
                    lineHeight
                    pdfRole
                  }
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "styles": [
              {
                "styleKey": "pdf.body",
                "fontFamilySlug": "lora",
                "fontWeight": 400,
                "fontStyle": "normal",
                "sizePx": 18,
                "lineHeight": 1.7
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(valid.get("errors").is_none(), "valid typography update failed: {valid}");
    let theme = &valid["data"]["admin"]["setTypographyStyles"]["theme"];
    let theme_slug = theme["slug"].as_str().expect("theme slug").to_string();
    let typography_slug = theme["typographySlug"].as_str().expect("typography slug").to_string();
    assert_eq!(theme["origin"], "custom");
    assert_eq!(theme["locked"], false);
    assert_ne!(
      theme_slug, "stuttgart",
      "locked system theme must not be edited in place"
    );
    let styles = theme["typographyStyles"].as_array().expect("styles");
    assert!(
      styles.iter().any(|style| {
        style["styleKey"] == "pdf.body"
          && style["pdfRole"] == "body"
          && style["fontFamilySlug"] == "lora"
          && style["fontWeight"] == 400
          && style["sizePx"] == 18.0
          && style["lineHeight"] == 1.7
      }),
      "pdf.body role must be preserved while updating the style: {styles:?}"
    );

    let system_pdf_body: (String, i32) = sqlx::query_as(
      r#"
      SELECT ff.slug, s.font_weight
      FROM typography_styles s
      JOIN typography_sets ts ON ts.id = s.typography_id
      JOIN font_families ff ON ff.id = s.font_family_id
      WHERE ts.slug = 'stuttgart' AND s.style_key = 'pdf.body'
      "#,
    )
    .fetch_one(&pool)
    .await
    .expect("system typography style");
    assert_eq!(
      system_pdf_body,
      ("inter".to_string(), 400),
      "system seed typography must stay untouched by AdminRoot edits"
    );

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme");
    sqlx::query("DELETE FROM themes WHERE slug = $1")
      .bind(&theme_slug)
      .execute(&pool)
      .await
      .expect("delete cloned theme");
    sqlx::query(
      "DELETE FROM typography_styles WHERE typography_id IN (SELECT id FROM typography_sets WHERE slug = $1)",
    )
    .bind(&typography_slug)
    .execute(&pool)
    .await
    .expect("delete cloned styles");
    sqlx::query("DELETE FROM typography_sets WHERE slug = $1")
      .bind(&typography_slug)
      .execute(&pool)
      .await
      .expect("delete cloned typography set");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_theme_db_api_04_color_mutation_validates_tokens_and_clone_on_write() {
  helpers::block_on_large_stack("inv-theme-db-api-04", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;

    let invalid_hex = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation InvalidColor($input: SetColorSchemaValuesInput!) {
            admin {
              setColorSchemaValues(input: $input) {
                theme { slug }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "colors": [
              {
                "mode": "light",
                "tokenKey": "accent-primary",
                "value": "red"
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      invalid_hex
        .get("errors")
        .and_then(|errors| errors.as_array())
        .is_some_and(|errors| {
          errors.iter().any(|error| {
            error["message"]
              .as_str()
              .is_some_and(|message| message.contains("expected #RRGGBB"))
          })
        }),
      "invalid color value must fail before color schema is persisted: {invalid_hex}"
    );

    let invalid_token = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation InvalidColorToken($input: SetColorSchemaValuesInput!) {
            admin {
              setColorSchemaValues(input: $input) {
                theme { slug }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "colors": [
              {
                "mode": "light",
                "tokenKey": "unknown-token",
                "value": "#123456"
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      invalid_token
        .get("errors")
        .and_then(|errors| errors.as_array())
        .is_some_and(|errors| {
          errors.iter().any(|error| {
            error["message"]
              .as_str()
              .is_some_and(|message| message.contains("not part of the server theme contract"))
          })
        }),
      "unknown color token must fail before color schema is persisted: {invalid_token}"
    );

    let valid = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation UpdateColors($input: SetColorSchemaValuesInput!) {
            admin {
              setColorSchemaValues(input: $input) {
                theme {
                  slug
                  origin
                  locked
                  colorSchemaSlug
                  colors
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "colors": [
              {
                "mode": "light",
                "tokenKey": "link-default",
                "value": "#ABCDEF"
              },
              {
                "mode": "dark",
                "tokenKey": "accent-secondary",
                "value": "#123456"
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(valid.get("errors").is_none(), "valid color update failed: {valid}");
    let theme = &valid["data"]["admin"]["setColorSchemaValues"]["theme"];
    let theme_slug = theme["slug"].as_str().expect("theme slug").to_string();
    let color_schema_slug = theme["colorSchemaSlug"]
      .as_str()
      .expect("color schema slug")
      .to_string();
    assert_eq!(theme["origin"], "custom");
    assert_eq!(theme["locked"], false);
    assert_ne!(
      theme_slug, "stuttgart",
      "locked system theme must not be edited in place"
    );
    assert_eq!(theme["colors"]["light"]["link-default"], "#abcdef");
    assert_eq!(theme["colors"]["light"]["accent-primary"], "#1f3a52");
    assert_eq!(theme["colors"]["dark"]["accent-secondary"], "#123456");

    let system_accent: String = sqlx::query_scalar(
      r#"
      SELECT csv.value
      FROM color_schema_values csv
      JOIN color_schemas cs ON cs.id = csv.schema_id
      WHERE cs.slug = 'stuttgart' AND csv.mode = 'light' AND csv.token_key = 'accent-primary'
      "#,
    )
    .fetch_one(&pool)
    .await
    .expect("system color value");
    assert_eq!(
      system_accent, "#1f3a52",
      "system seed color schema must stay untouched by AdminRoot edits"
    );

    let cloned_value_count: i64 = sqlx::query_scalar(
      r#"
      SELECT COUNT(*)
      FROM color_schema_values csv
      JOIN color_schemas cs ON cs.id = csv.schema_id
      WHERE cs.slug = $1
      "#,
    )
    .bind(&color_schema_slug)
    .fetch_one(&pool)
    .await
    .expect("cloned color schema values");
    let source_value_count: i64 = sqlx::query_scalar(
      r#"
      SELECT COUNT(*)
      FROM color_schema_values csv
      JOIN color_schemas cs ON cs.id = csv.schema_id
      WHERE cs.slug = 'stuttgart'
      "#,
    )
    .fetch_one(&pool)
    .await
    .expect("source color schema values");
    assert_eq!(
      cloned_value_count, source_value_count,
      "clone-on-write color schema must retain every source light/dark token"
    );

    let (color_schema_id, typography_id): (Uuid, Uuid) =
      sqlx::query_as("SELECT color_schema_id, typography_id FROM themes WHERE slug = $1")
        .bind(&theme_slug)
        .fetch_one(&pool)
        .await
        .expect("cloned theme ids");
    let shared_theme_slug = format!("{theme_slug}-shared-test");
    sqlx::query(
      r#"
      INSERT INTO themes (
        id, slug, name, origin, locked, color_schema_id, typography_id,
        is_default, created_by
      )
      VALUES ($1, $2, $3, 'custom', FALSE, $4, $5, FALSE, $6)
      "#,
    )
    .bind(Uuid::new_v4())
    .bind(&shared_theme_slug)
    .bind("Shared Color Schema Test Theme")
    .bind(color_schema_id)
    .bind(typography_id)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("insert second theme sharing color schema");
    let old_shared_value_before: String = sqlx::query_scalar(
      r#"
      SELECT csv.value
      FROM color_schema_values csv
      JOIN color_schemas cs ON cs.id = csv.schema_id
      WHERE cs.slug = $1 AND csv.mode = 'light' AND csv.token_key = 'accent-secondary'
      "#,
    )
    .bind(&color_schema_slug)
    .fetch_one(&pool)
    .await
    .expect("old shared color schema value before second edit");

    let shared_update = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation UpdateSharedColors($input: SetColorSchemaValuesInput!) {
            admin {
              setColorSchemaValues(input: $input) {
                theme {
                  slug
                  colorSchemaSlug
                  colors
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "colors": [
              {
                "mode": "light",
                "tokenKey": "accent-secondary",
                "value": "#654321"
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      shared_update.get("errors").is_none(),
      "shared color schema update failed: {shared_update}"
    );
    let shared_update_theme = &shared_update["data"]["admin"]["setColorSchemaValues"]["theme"];
    let second_theme_slug = shared_update_theme["slug"]
      .as_str()
      .expect("second color clone theme slug")
      .to_string();
    let second_color_schema_slug = shared_update_theme["colorSchemaSlug"]
      .as_str()
      .expect("second color clone schema slug")
      .to_string();
    assert_ne!(
      second_color_schema_slug, color_schema_slug,
      "a color schema referenced by another theme must be clone-on-write, not updated in place"
    );
    assert_eq!(shared_update_theme["colors"]["light"]["accent-secondary"], "#654321");

    let old_shared_value: String = sqlx::query_scalar(
      r#"
      SELECT csv.value
      FROM color_schema_values csv
      JOIN color_schemas cs ON cs.id = csv.schema_id
      WHERE cs.slug = $1 AND csv.mode = 'light' AND csv.token_key = 'accent-secondary'
      "#,
    )
    .bind(&color_schema_slug)
    .fetch_one(&pool)
    .await
    .expect("old shared color schema value");
    assert_eq!(
      old_shared_value, old_shared_value_before,
      "shared color schema must stay untouched when the profile receives a second clone"
    );

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme");
    sqlx::query("DELETE FROM themes WHERE slug = $1")
      .bind(&second_theme_slug)
      .execute(&pool)
      .await
      .expect("delete second cloned theme");
    sqlx::query("DELETE FROM color_schema_values WHERE schema_id IN (SELECT id FROM color_schemas WHERE slug = $1)")
      .bind(&second_color_schema_slug)
      .execute(&pool)
      .await
      .expect("delete second cloned color values");
    sqlx::query("DELETE FROM color_schemas WHERE slug = $1")
      .bind(&second_color_schema_slug)
      .execute(&pool)
      .await
      .expect("delete second cloned color schema");
    sqlx::query("DELETE FROM themes WHERE slug = $1")
      .bind(&shared_theme_slug)
      .execute(&pool)
      .await
      .expect("delete shared test theme");
    sqlx::query("DELETE FROM themes WHERE slug = $1")
      .bind(&theme_slug)
      .execute(&pool)
      .await
      .expect("delete cloned theme");
    sqlx::query("DELETE FROM color_schema_values WHERE schema_id IN (SELECT id FROM color_schemas WHERE slug = $1)")
      .bind(&color_schema_slug)
      .execute(&pool)
      .await
      .expect("delete cloned color values");
    sqlx::query("DELETE FROM color_schemas WHERE slug = $1")
      .bind(&color_schema_slug)
      .execute(&pool)
      .await
      .expect("delete cloned color schema");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_theme_db_api_05_workspace_runtime_css_and_reset_inherit_global_profile() {
  helpers::block_on_large_stack("inv-theme-db-api-05", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", Some(admin_id))
      .await
      .expect("seed deterministic global theme profile");

    let workspace_override = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation SetWorkspaceTheme($input: SetThemeProfileInput!) {
            admin {
              setThemeProfile(input: $input) {
                scope
                workspaceId
                themeMode
                theme { slug }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "themeSlug": "hamburg",
            "themeMode": "dark"
          }
        }
      }),
    )
    .await;
    assert!(
      workspace_override.get("errors").is_none(),
      "workspace theme override failed: {workspace_override}"
    );
    assert_eq!(
      workspace_override["data"]["admin"]["setThemeProfile"]["scope"],
      "workspace"
    );
    assert_eq!(
      workspace_override["data"]["admin"]["setThemeProfile"]["workspaceId"],
      workspace_id.to_string()
    );

    let (global_status, global_css_body) = helpers::get_raw(&app, "/api/branding/theme.css").await;
    assert_eq!(global_status, 200, "global runtime CSS failed");
    let global_css = String::from_utf8_lossy(&global_css_body);

    let workspace_path = format!("/api/branding/theme.css?workspaceId={workspace_id}");
    let (workspace_status, workspace_css_body) = helpers::get_raw(&app, &workspace_path).await;
    assert_eq!(workspace_status, 200, "workspace runtime CSS failed");
    let workspace_css = String::from_utf8_lossy(&workspace_css_body);
    assert_ne!(
      workspace_css, global_css,
      "workspace runtime CSS must differ from the global projection while an override is active"
    );

    let color_override = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation SetWorkspaceColor($input: SetColorSchemaValuesInput!) {
            admin {
              setColorSchemaValues(input: $input) {
                theme {
                  slug
                  colorSchemaSlug
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "colors": [
              { "mode": "light", "tokenKey": "accent-primary", "value": "#123456" }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      color_override.get("errors").is_none(),
      "workspace color override failed: {color_override}"
    );
    let workspace_theme_slug = color_override["data"]["admin"]["setColorSchemaValues"]["theme"]["slug"]
      .as_str()
      .expect("workspace clone theme slug")
      .to_string();
    let workspace_color_schema_slug =
      color_override["data"]["admin"]["setColorSchemaValues"]["theme"]["colorSchemaSlug"]
        .as_str()
        .expect("workspace clone color schema slug")
        .to_string();
    assert!(
      workspace_theme_slug.contains("-workspace-colors-"),
      "workspace color edit must create a workspace-scoped theme clone, got {workspace_theme_slug}"
    );
    assert!(
      workspace_color_schema_slug.contains("-workspace-colors-"),
      "workspace color edit must create a workspace-scoped color schema clone, got {workspace_color_schema_slug}"
    );

    let typography_override = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation SetWorkspaceTypography($input: SetTypographyStylesInput!) {
            admin {
              setTypographyStyles(input: $input) {
                theme {
                  slug
                  typographySlug
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "styles": [
              {
                "styleKey": "body.default",
                "fontFamilySlug": "lora",
                "fontWeight": 400,
                "fontStyle": "normal",
                "sizePx": 16,
                "lineHeight": 1.6
              }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      typography_override.get("errors").is_none(),
      "workspace typography override failed: {typography_override}"
    );
    let workspace_typography_theme_slug = typography_override["data"]["admin"]["setTypographyStyles"]["theme"]["slug"]
      .as_str()
      .expect("workspace typography clone theme slug")
      .to_string();
    let workspace_typography_slug =
      typography_override["data"]["admin"]["setTypographyStyles"]["theme"]["typographySlug"]
        .as_str()
        .expect("workspace typography clone slug")
        .to_string();
    assert!(
      workspace_typography_theme_slug.contains("-workspace-typography-"),
      "workspace typography edit must create a workspace-scoped theme clone, got {workspace_typography_theme_slug}"
    );
    assert!(
      workspace_typography_slug.contains("-workspace-"),
      "workspace typography edit must create a workspace-scoped typography clone, got {workspace_typography_slug}"
    );

    let catalog = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          query ThemeCatalog {
            admin {
              themeCatalog {
                themes { slug origin }
              }
            }
          }
        "#
      }),
    )
    .await;
    assert!(catalog.get("errors").is_none(), "theme catalog failed: {catalog}");
    let catalog_themes = catalog["data"]["admin"]["themeCatalog"]["themes"]
      .as_array()
      .expect("theme catalog themes");
    assert!(
      catalog_themes
        .iter()
        .all(|theme| theme["slug"] != workspace_theme_slug && theme["slug"] != workspace_typography_theme_slug),
      "workspace-origin clone themes must not be exposed as selectable catalog themes: {catalog_themes:?}"
    );

    let mode_only_update_on_own_clone = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation SetOwnWorkspaceCloneMode($input: SetThemeProfileInput!) {
            admin {
              setThemeProfile(input: $input) {
                scope
                themeMode
                theme { slug }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "themeSlug": workspace_typography_theme_slug,
            "themeMode": "light"
          }
        }
      }),
    )
    .await;
    assert!(
      mode_only_update_on_own_clone.get("errors").is_none(),
      "own workspace-origin clone must remain selectable by its owning workspace for mode changes: {mode_only_update_on_own_clone}"
    );

    let global_select_clone = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation SelectWorkspaceCloneGlobally($input: SetThemeProfileInput!) {
            admin {
              setThemeProfile(input: $input) { theme { slug } }
            }
          }
        "#,
        "variables": {
          "input": { "themeSlug": workspace_typography_theme_slug, "themeMode": "dark" }
        }
      }),
    )
    .await;
    assert!(
      global_select_clone.get("errors").is_some(),
      "workspace-origin clone themes must not be selectable as global themes: {global_select_clone}"
    );

    let (invalid_status, _) = helpers::get_raw(&app, "/api/branding/theme.css?workspaceId=not-a-uuid").await;
    assert_eq!(
      invalid_status, 400,
      "runtime CSS must reject malformed workspace ids instead of silently falling back"
    );

    let unknown_workspace_id = Uuid::new_v4();
    let (unknown_status, _) = helpers::get_raw(
      &app,
      &format!("/api/branding/theme.css?workspaceId={unknown_workspace_id}"),
    )
    .await;
    assert_eq!(
      unknown_status, 404,
      "runtime CSS must reject unknown workspace ids instead of silently falling back"
    );

    let reset = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation ResetWorkspaceTheme($input: ResetWorkspaceThemeProfileInput!) {
            admin {
              resetWorkspaceThemeProfile(input: $input) {
                scope
                workspaceId
                themeMode
                theme { slug }
              }
            }
          }
        "#,
        "variables": {
          "input": { "workspaceId": workspace_id.to_string() }
        }
      }),
    )
    .await;
    assert!(reset.get("errors").is_none(), "workspace theme reset failed: {reset}");
    assert_eq!(reset["data"]["admin"]["resetWorkspaceThemeProfile"]["scope"], "global");
    assert_eq!(
      reset["data"]["admin"]["resetWorkspaceThemeProfile"]["theme"]["slug"],
      "stuttgart"
    );

    let (after_reset_status, after_reset_css_body) = helpers::get_raw(&app, &workspace_path).await;
    assert_eq!(after_reset_status, 200, "workspace inherited runtime CSS failed");
    let after_reset_css = String::from_utf8_lossy(&after_reset_css_body);
    assert_eq!(
      after_reset_css, global_css,
      "reset workspace must inherit the global runtime CSS projection"
    );

    let orphaned_theme: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM themes WHERE slug = $1")
      .bind(&workspace_theme_slug)
      .fetch_one(&pool)
      .await
      .expect("count reset workspace theme clone");
    assert_eq!(
      orphaned_theme, 0,
      "reset workspace branding must delete orphaned workspace theme clone {workspace_theme_slug}"
    );
    let orphaned_color_schema: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM color_schemas WHERE slug = $1")
      .bind(&workspace_color_schema_slug)
      .fetch_one(&pool)
      .await
      .expect("count reset workspace color schema clone");
    assert_eq!(
      orphaned_color_schema, 0,
      "reset workspace branding must delete orphaned workspace color schema clone {workspace_color_schema_slug}"
    );
    let orphaned_typography_theme: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM themes WHERE slug = $1")
      .bind(&workspace_typography_theme_slug)
      .fetch_one(&pool)
      .await
      .expect("count reset workspace typography theme clone");
    assert_eq!(
      orphaned_typography_theme, 0,
      "reset workspace branding must delete orphaned workspace typography theme clone {workspace_typography_theme_slug}"
    );
    let orphaned_typography_set: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM typography_sets WHERE slug = $1")
      .bind(&workspace_typography_slug)
      .fetch_one(&pool)
      .await
      .expect("count reset workspace typography clone");
    assert_eq!(
      orphaned_typography_set, 0,
      "reset workspace branding must delete orphaned workspace typography clone {workspace_typography_slug}"
    );

    sqlx::query("DELETE FROM theme_profiles WHERE workspace_id = $1")
      .bind(workspace_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
      .bind(workspace_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(workspace_id)
      .execute(&pool)
      .await
      .ok();
    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", None)
      .await
      .expect("reset global theme");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn inv_theme_db_api_06_workspace_delete_cleans_theme_overrides() {
  helpers::block_on_large_stack("inv-theme-db-api-06", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let _guard = helpers::THEME_BRANDING_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;

    myoxus_infrastructure::branding::set_theme_profile(&pool, None, "stuttgart", "system", Some(admin_id))
      .await
      .expect("seed deterministic global theme profile");

    let color_update = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation WorkspaceColorOverride($input: SetColorSchemaValuesInput!) {
            admin {
              setColorSchemaValues(input: $input) {
                scope
                workspaceId
                theme {
                  slug
                  origin
                  colorSchemaSlug
                  typographySlug
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "colors": [
              { "mode": "light", "tokenKey": "accent-primary", "value": "#123456" }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      color_update.get("errors").is_none(),
      "workspace color override failed: {color_update}"
    );
    assert_eq!(
      color_update["data"]["admin"]["setColorSchemaValues"]["scope"],
      "workspace"
    );
    let color_theme_slug = color_update["data"]["admin"]["setColorSchemaValues"]["theme"]["slug"]
      .as_str()
      .expect("color override theme slug")
      .to_string();
    let color_schema_slug = color_update["data"]["admin"]["setColorSchemaValues"]["theme"]["colorSchemaSlug"]
      .as_str()
      .expect("color override schema slug")
      .to_string();

    let typography_update = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation WorkspaceTypographyOverride($input: SetTypographyStylesInput!) {
            admin {
              setTypographyStyles(input: $input) {
                scope
                workspaceId
                theme {
                  slug
                  origin
                  colorSchemaSlug
                  typographySlug
                  typographyStyles {
                    styleKey
                    sizePx
                  }
                }
              }
            }
          }
        "#,
        "variables": {
          "input": {
            "workspaceId": workspace_id.to_string(),
            "styles": [
              { "styleKey": "heading.h1", "sizePx": 47.0 }
            ]
          }
        }
      }),
    )
    .await;
    assert!(
      typography_update.get("errors").is_none(),
      "workspace typography override failed: {typography_update}"
    );
    let typography_theme_slug = typography_update["data"]["admin"]["setTypographyStyles"]["theme"]["slug"]
      .as_str()
      .expect("typography override theme slug")
      .to_string();
    let typography_slug = typography_update["data"]["admin"]["setTypographyStyles"]["theme"]["typographySlug"]
      .as_str()
      .expect("typography override slug")
      .to_string();

    let delete = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation DeleteWorkspaceWithThemeOverrides($id: ID!) {
            admin {
              deleteWorkspace(id: $id)
            }
          }
        "#,
        "variables": { "id": workspace_id.to_string() }
      }),
    )
    .await;
    assert!(
      delete.get("errors").is_none(),
      "workspace delete with theme overrides failed: {delete}"
    );
    assert_eq!(delete["data"]["admin"]["deleteWorkspace"], true);

    for (table, slug) in [
      ("themes", color_theme_slug.as_str()),
      ("themes", typography_theme_slug.as_str()),
      ("color_schemas", color_schema_slug.as_str()),
      ("typography_sets", typography_slug.as_str()),
    ] {
      let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE slug = $1"))
        .bind(slug)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|err| panic!("count {table}.{slug}: {err}"));
      assert_eq!(
        count, 0,
        "admin deleteWorkspace must clean orphaned workspace theme override row {table}.{slug}"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}
