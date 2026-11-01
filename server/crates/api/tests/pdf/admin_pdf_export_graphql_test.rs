// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! AdminRoot contract coverage for PDF export operator data.
//!
//! PDF export has two legitimate GraphQL surfaces: regular workspace users
//! start/poll their own exports on the public root, while operator metadata,
//! library management and diagnostics belong under `admin { ... }`. These
//! tests pin that boundary so the adminfrontend cannot drift back to flat-root
//! admin operations.

use crate::helpers;
use serde_json::{Value, json};
use uuid::Uuid;

async fn insert_queued_pdf_export_job(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  doc_id: Uuid,
  requested_by: Uuid,
) -> Uuid {
  let job_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO pdf_export_jobs \
       (id, workspace_id, doc_id, requested_by, template_id, render_inputs, options_hash, status, sync_or_async) \
       VALUES ($1, $2, $3, $4, 'default', '{}'::jsonb, $5, 'queued', 'sync')",
  )
  .bind(job_id)
  .bind(workspace_id)
  .bind(doc_id)
  .bind(requested_by)
  .bind(format!("admin-root-cancel-{job_id}"))
  .execute(pool)
  .await
  .expect("insert queued pdf export job");
  job_id
}

async fn cleanup_pdf_export_jobs(pool: &sqlx::PgPool, workspace_id: Uuid) {
  sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
}

fn assert_no_graphql_errors(response: &Value, label: &str) {
  assert!(
    response.get("errors").is_none(),
    "{label} returned GraphQL errors: {response}"
  );
}

fn assert_graphql_rejected(response: &Value, label: &str) {
  assert!(
    response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
    "{label} must reject unauthorized access: {response}"
  );
}

fn field_names(response: &Value, path: &[&str]) -> Vec<String> {
  let value = path.iter().fold(response, |acc, segment| &acc[*segment]);
  value
    .as_array()
    .unwrap_or_else(|| panic!("{} must be an array in {response}", path.join(".")))
    .iter()
    .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
    .collect()
}

#[test]
fn admin_pdf_export_fields_are_admin_root_only() {
  helpers::block_on_large_stack("admin-pdf-export-introspection", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

    let response = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "{ __schema { queryType { fields(includeDeprecated: true) { name } } mutationType { fields(includeDeprecated: true) { name } } } __type(name: \"AdminRoot\") { fields(includeDeprecated: true) { name } } }"
      }),
    )
    .await;
    assert_no_graphql_errors(&response, "admin pdf export introspection");

    let query_fields = field_names(&response, &["data", "__schema", "queryType", "fields"]);
    let mutation_fields = field_names(&response, &["data", "__schema", "mutationType", "fields"]);
    let admin_fields = field_names(&response, &["data", "__type", "fields"]);

    for name in [
      "pdfExportJobs",
      "pdfTemplatePreviewPdf",
      "pdfIccProfiles",
      "pdfIccProfile",
      "pdfFonts",
      "pdfFont",
      "pdfWorkspaceAssignments",
      "pdfTemplateAssignedWorkspaces",
      "documentBrandingProfile",
      "pdfExportSettings",
      "pdfTemplates",
      "pdfTemplate",
      "pdfTemplateFiles",
      "uploadIccProfile",
      "deleteIccProfile",
      "uploadPdfFont",
      "approvePdfFont",
      "rejectPdfFont",
      "deletePdfFont",
      "assignPdfTemplateToWorkspace",
      "unassignPdfTemplateFromWorkspace",
      "setWorkspaceDefaultPdfTemplate",
      "uploadDocumentBrandLogo",
      "deleteDocumentBrandLogo",
      "updateDocumentBrandingText",
      "updateDocumentBrandingColors",
      "setDocumentBrandingColorPolicy",
      "updatePdfExportSettings",
      "uploadPdfTemplate",
      "deletePdfTemplate",
      "updatePdfTemplateMetadata",
      "setWorkspaceTemplateOverride",
    ] {
      assert!(admin_fields.contains(&name.to_string()), "AdminRoot missing {name}");
    }

    for name in [
      "adminPdfExportJobs",
      "pdfExportJobs",
      "pdfIccProfiles",
      "pdfIccProfile",
      "pdfFonts",
      "pdfFont",
      "pdfWorkspaceAssignments",
      "pdfTemplateAssignedWorkspaces",
      "pdfTemplates",
      "pdfTemplate",
      "pdfTemplateFiles",
    ] {
      assert!(
        !query_fields.contains(&name.to_string()),
        "{name} leaked to flat Query root"
      );
    }

    for name in [
      "uploadIccProfile",
      "deleteIccProfile",
      "uploadPdfFont",
      "approvePdfFont",
      "rejectPdfFont",
      "deletePdfFont",
      "assignPdfTemplateToWorkspace",
      "unassignPdfTemplateFromWorkspace",
      "setWorkspaceDefaultPdfTemplate",
      "uploadDocumentBrandLogo",
      "deleteDocumentBrandLogo",
      "updateDocumentBrandingText",
      "updateDocumentBrandingColors",
      "updatePdfExportSettings",
      "uploadPdfTemplate",
      "deletePdfTemplate",
      "updatePdfTemplateMetadata",
      "setWorkspaceTemplateOverride",
    ] {
      assert!(
        !mutation_fields.contains(&name.to_string()),
        "{name} leaked to flat Mutation root"
      );
    }

    // These public workspace-user fields intentionally remain on the root.
    for name in [
      "exportPdf",
      "pdfExportJob",
      "documentPdfExportHistory",
      "availablePdfTemplates",
      "documentBrandingProfile",
      "pdfExportSettings",
      "pdfTemplatePreviewPdf",
    ] {
      assert!(
        query_fields.contains(&name.to_string()) || mutation_fields.contains(&name.to_string()),
        "public PDF field {name} unexpectedly missing from the root surface"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn admin_pdf_export_queries_require_admin_and_use_real_repositories() {
  helpers::block_on_large_stack("admin-pdf-export-auth", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_pdf_admin_repos().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "pdf-export-non-admin").await;

    let query = r#"
      query AdminPdfExportSurface {
        admin {
          pdfTemplates { id slug name version }
          pdfFonts { id familyName licenseStatus }
          pdfIccProfiles { id name profileType }
          pdfExportJobs(filter: { limit: 5 }) { id status workspaceId docId }
        }
      }
    "#;

    let admin = helpers::gql(&app, admin_session, json!({ "query": query })).await;
    assert_no_graphql_errors(&admin, "admin pdf export surface");
    assert!(admin["data"]["admin"]["pdfTemplates"].as_array().is_some());
    assert!(admin["data"]["admin"]["pdfFonts"].as_array().is_some());
    assert!(admin["data"]["admin"]["pdfIccProfiles"].as_array().is_some());
    assert!(admin["data"]["admin"]["pdfExportJobs"].as_array().is_some());

    let non_admin = helpers::gql(&app, user_session, json!({ "query": query })).await;
    assert_graphql_rejected(&non_admin, "non-admin pdf export surface");

    let anonymous = helpers::gql_anon(
      &app,
      json!({
        "query": "query { admin { pdfTemplates { id } } }"
      }),
    )
    .await;
    assert_graphql_rejected(&anonymous, "anonymous pdf export surface");

    helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
  });
}

#[test]
fn admin_pdf_export_cancel_requires_admin_even_for_job_owner() {
  helpers::block_on_large_stack("admin-pdf-export-cancel-auth", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "pdf-export-owner").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let job_id = insert_queued_pdf_export_job(&pool, workspace_id, doc_id, owner_id).await;

    let mutation = r#"
      mutation AdminCancelPdfExportJob($jobId: String!) {
        admin {
          cancelPdfExportJob(jobId: $jobId)
        }
      }
    "#;
    let variables = json!({ "jobId": job_id.to_string() });

    let owner = helpers::gql(
      &app,
      owner_session,
      json!({ "query": mutation, "variables": variables.clone() }),
    )
    .await;
    assert_graphql_rejected(&owner, "job owner must not use AdminRoot cancel");

    let status: String = sqlx::query_scalar("SELECT status::TEXT FROM pdf_export_jobs WHERE id = $1")
      .bind(job_id)
      .fetch_one(&pool)
      .await
      .expect("job row");
    assert_eq!(status, "queued", "rejected AdminRoot cancel must not mutate job row");

    let admin = helpers::gql(
      &app,
      admin_session,
      json!({ "query": mutation, "variables": variables }),
    )
    .await;
    assert_no_graphql_errors(&admin, "admin pdf export cancel");
    assert_eq!(admin["data"]["admin"]["cancelPdfExportJob"], true);

    let (status, error_detail): (String, Option<String>) =
      sqlx::query_as("SELECT status::TEXT, error_detail FROM pdf_export_jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .expect("job row after admin cancel");
    assert_eq!(status, "failed");
    assert_eq!(error_detail.as_deref(), Some("cancelled by admin"));

    cleanup_pdf_export_jobs(&pool, workspace_id).await;
    helpers::cleanup_users(&pool, &[admin_id, owner_id]).await;
  });
}
