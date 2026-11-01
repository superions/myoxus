// SPDX-License-Identifier: AGPL-3.0-or-later
//! The retired Team GraphQL parallel model must not remain discoverable.

use crate::helpers;

use serde_json::json;

#[tokio::test]
async fn inv_org_d_t06_legacy_team_fields_are_absent() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "{
        adminRoot: __type(name: \"AdminRoot\") {
          fields(includeDeprecated: true) { name }
        }
        workspace: __type(name: \"WorkspaceType\") {
          fields(includeDeprecated: true) { name }
        }
        unit: __type(name: \"OrganizationUnitTypeOutput\") {
          fields(includeDeprecated: true) { name }
        }
        unitWorkspace: __type(name: \"OrganizationUnitWorkspaceType\") {
          fields(includeDeprecated: true) { name }
        }
      }"
    }),
  )
  .await;

  let fields = resp["data"]["adminRoot"]["fields"]
    .as_array()
    .unwrap_or_else(|| panic!("AdminRoot fields missing in introspection: {resp}"));

  let forbidden = [
    "teams",
    "teamsCount",
    "team",
    "teamMembers",
    "teamMembersCount",
    "createTeam",
    "updateTeam",
    "deleteTeam",
    "addTeamMember",
    "updateTeamMemberRole",
    "removeTeamMember",
  ];

  for name in forbidden {
    assert!(
      fields.iter().all(|field| field["name"].as_str() != Some(name)),
      "AdminRoot.{name} must be absent after Team model removal: {resp}"
    );
  }
  let workspace_fields = resp["data"]["workspace"]["fields"]
    .as_array()
    .unwrap_or_else(|| panic!("Workspace fields missing in introspection: {resp}"));
  for name in ["team", "isTeam", "isManagedTeam"] {
    assert!(
      workspace_fields.iter().all(|field| field["name"] != name),
      "Workspace.{name} must be absent after Team model removal: {resp}"
    );
  }
  let unit_fields = resp["data"]["unit"]["fields"]
    .as_array()
    .unwrap_or_else(|| panic!("OrganizationUnitTypeOutput fields missing: {resp}"));
  assert!(
    unit_fields.iter().any(|field| field["name"] == "maxMembers"),
    "OrganizationUnitTypeOutput.maxMembers must be the typed limit: {resp}"
  );
  let unit_workspace_fields = resp["data"]["unitWorkspace"]["fields"]
    .as_array()
    .unwrap_or_else(|| panic!("OrganizationUnitWorkspaceType fields missing: {resp}"));
  assert!(
    unit_workspace_fields
      .iter()
      .all(|field| field["name"] != "storageLimitMb"),
    "OU-workspace links must not expose a second quota override: {resp}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
