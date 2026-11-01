// SPDX-License-Identifier: AGPL-3.0-or-later
//! Served GraphQL contract for organization-unit status and permanent delete.

use serde_json::json;
use uuid::Uuid;

use crate::helpers;

#[tokio::test]
async fn inv_graphql_organization_unit_delete_requires_matching_preview_contract() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let organization_id: Uuid = sqlx::query_scalar("SELECT id FROM organization WHERE key = 'myoxus'")
    .fetch_one(&pool)
    .await
    .expect("default organization");
  let unit_type_id: Uuid = sqlx::query_scalar(
    "SELECT id FROM organization_unit_type WHERE organization_id = $1 AND is_active AND can_be_root_level ORDER BY key LIMIT 1",
  )
  .bind(organization_id)
  .fetch_one(&pool)
  .await
  .expect("active root OU type");
  let unit_id = Uuid::new_v4();
  let unit_name = format!("GraphQL lifecycle {unit_id}");
  sqlx::query(
    "INSERT INTO organization_unit (id, organization_id, unit_type_id, name, slug, status, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, 'active', '{}', $6)",
  )
  .bind(unit_id)
  .bind(organization_id)
  .bind(unit_type_id)
  .bind(&unit_name)
  .bind(format!("graphql-lifecycle-{unit_id}"))
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("seed OU");

  let status = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($id:ID!,$status:OrganizationUnitStatusEnum!){admin{setOrganizationUnitStatus(id:$id,status:$status){id status}}}",
      "variables": { "id": unit_id, "status": "Disabled" }
    }),
  )
  .await;
  assert!(status.get("errors").is_none(), "status mutation failed: {status}");
  assert_eq!(
    status["data"]["admin"]["setOrganizationUnitStatus"]["status"],
    "Disabled"
  );

  let preview = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "query($id:ID!){admin{organizationUnitDeletionPreview(id:$id){id name status updatedAt deletable blockers{code count}}}}",
      "variables": { "id": unit_id }
    }),
  )
  .await;
  assert!(preview.get("errors").is_none(), "preview query failed: {preview}");
  let preview = &preview["data"]["admin"]["organizationUnitDeletionPreview"];
  assert_eq!(preview["deletable"], true);
  assert_eq!(preview["blockers"], json!([]));

  let mismatch = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($id:ID!,$name:String!,$revision:DateTime!){admin{deleteOrganizationUnitPermanently(id:$id,confirmedName:$name,previewRevision:$revision)}}",
      "variables": { "id": unit_id, "name": "wrong name", "revision": preview["updatedAt"] }
    }),
  )
  .await;
  assert_eq!(
    mismatch["errors"][0]["extensions"]["code"],
    "ORGANIZATION_UNIT_CONFIRMATION_MISMATCH"
  );

  let deleted = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "mutation($id:ID!,$name:String!,$revision:DateTime!){admin{deleteOrganizationUnitPermanently(id:$id,confirmedName:$name,previewRevision:$revision)}}",
      "variables": { "id": unit_id, "name": unit_name, "revision": preview["updatedAt"] }
    }),
  )
  .await;
  assert!(deleted.get("errors").is_none(), "permanent delete failed: {deleted}");
  assert_eq!(deleted["data"]["admin"]["deleteOrganizationUnitPermanently"], true);

  let audit = sqlx::query_as::<
    _,
    (
      Option<Uuid>,
      Option<String>,
      Option<String>,
      String,
      Option<serde_json::Value>,
      Option<serde_json::Value>,
    ),
  >(
    "SELECT target_unit_id, target_id, target_label, actor_kind, old_value, metadata
       FROM admin_audit_log
      WHERE event_key = 'organization.unit.delete' AND target_id = $1
      ORDER BY created_at DESC LIMIT 1",
  )
  .bind(unit_id.to_string())
  .fetch_one(&pool)
  .await
  .expect("organization delete audit");
  let unit_id_text = unit_id.to_string();
  assert_eq!(audit.0, None, "a deleted OU must not remain as audit foreign key");
  assert_eq!(audit.1.as_deref(), Some(unit_id_text.as_str()));
  assert_eq!(audit.2.as_deref(), Some(unit_name.as_str()));
  assert_eq!(audit.3, "user");
  assert_eq!(
    audit.4.as_ref().and_then(|value| value["id"].as_str()),
    Some(unit_id_text.as_str())
  );
  assert!(
    audit.5.as_ref().is_none_or(|metadata| {
      let serialized = metadata.to_string().to_ascii_lowercase();
      !serialized.contains("token") && !serialized.contains("secret") && !serialized.contains("password")
    }),
    "organization lifecycle audit must not contain credential material"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
