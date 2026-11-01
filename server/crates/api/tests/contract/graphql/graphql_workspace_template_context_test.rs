// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace Read, not organization administration, owns template context.
use crate::helpers;
use async_trait::async_trait;
use futures_util::FutureExt;
use myoxus_domain::{
  entities::{Organization, OrganizationUnitWorkspace, OrganizationUnitWorkspaceRelationship},
  repositories::{OrganizationRepository, OrganizationUnitWorkspaceRepository, RepoResult, RepositoryError},
};
use serde_json::json;
use std::sync::{
  Arc,
  atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;

// Read faults are injected at the two actual ports, without modifying global
// organization data or weakening the database's single-owner constraint.
struct OrganizationFixture {
  value: Option<Organization>,
  reads: AtomicUsize,
  fail: bool,
}

#[test]
fn requested_template_facts_use_committed_creator_and_lazy_permission_boundaries() {
  helpers::block_on_large_stack(
    "requested_template_facts_use_committed_creator_and_lazy_permission_boundaries",
    || async {
      let (app, pool, auth) = helpers::setup_app().await;
      let (creator, creator_session) =
        helpers::seed_user_with_name(&pool, &auth, "template-facts-creator", " Original creator ").await;
      let (actor, actor_session) =
        helpers::seed_user_with_name(&pool, &auth, "template-facts-actor", " Applying actor ").await;
      let (pending, _) = helpers::seed_user(&pool, &auth, "template-facts-pending").await;
      let workspace = helpers::create_workspace(&pool, creator).await;
      let outcome = std::panic::AssertUnwindSafe(async {
      helpers::add_workspace_member(&pool, workspace, actor).await;
      sqlx::query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Pending')",
      )
      .bind(workspace)
      .bind(pending)
      .execute(&pool)
      .await
      .expect("pending member");
      let doc = helpers::create_doc(&pool, workspace, creator).await;
      let external = format!("template-facts-{doc}");
      sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
        .bind(doc)
        .bind(&external)
        .execute(&pool)
        .await
        .expect("canonical alias");
      let created_at: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT created_at FROM docs WHERE id=$1")
        .bind(doc)
        .fetch_one(&pool)
        .await
        .expect("actual committed creation instant");
      let creator_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id=$1")
        .bind(creator)
        .fetch_one(&pool)
        .await
        .expect("creator email");
      let query = |names: &[&str], target: Option<&str>, defer: bool| {
        json!({
          "query": "query($id: String!, $names: [String!]!, $target: String, $defer: Boolean!) { workspace(id: $id) { templateContext { requestedValues(requested: $names, targetDocId: $target, deferCreation: $defer) } } }",
          "variables": {"id":workspace,"names":names,"target":target,"defer":defer}
        })
      };
      let paths = [
        "creator.name",
        "creator.email",
        "document.created_at.date",
        "document.created_at.time",
        "document.created_at.datetime",
        "workspace.members",
        "actor.name",
        "actor.email",
      ];
      let facts = helpers::gql(&app, actor_session, query(&paths, Some(&external), false)).await;
      assert!(facts.get("errors").is_none(), "{facts}");
      let values = &facts["data"]["workspace"]["templateContext"]["requestedValues"];
      assert_eq!(values["creator.name"], "Original creator");
      assert_eq!(values["creator.email"], creator_email);
      let actor_email: String = sqlx::query_scalar("SELECT email FROM users WHERE id=$1")
        .bind(actor).fetch_one(&pool).await.expect("stored applying email");
      assert_eq!(values["actor.name"], "Applying actor");
      assert_eq!(values["actor.email"], actor_email);
      for path in &paths[2..5] {
        assert_eq!(values[path], created_at.to_rfc3339());
      }
      let members = values["workspace.members"].as_array().expect("record inventory");
      assert_eq!(members.len(), 2, "pending members are not facts");
      assert_eq!(members[0]["name"], "Original creator");
      assert_eq!(members[1]["name"], "Applying actor");
      let docs = myoxus_application::doc::DocService::new(Arc::new(
        myoxus_infrastructure::doc::SqlxDocStore::new(pool.clone()),
      ));
      myoxus_application::workspace::WorkspaceService::new(Arc::new(
        myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(), crate::helpers::database_starter_catalog()),
      ))
      .seed_root_doc(workspace, creator, yjs::create_initial_workspace_doc("Template facts"))
      .await
      .expect("workspace root");
      let organizer = myoxus_application::organizer::OrganizerService::new(docs);
      let top = organizer.create_folder(workspace, myoxus_application::organizer::CreateOrganizerFolder {
        id: Uuid::new_v4().to_string(), parent_id: None, name: " Top ".into(), index: None,
      }).await.expect("real ancestor");
      let folder = organizer
        .create_folder(workspace, myoxus_application::organizer::CreateOrganizerFolder {
          id: Uuid::new_v4().to_string(), parent_id: Some(top.id), name: "Real destination".into(), index: None,
        })
        .await
        .expect("valid future destination");
      let unplaced = helpers::gql(&app, actor_session, json!({
        "query": "query($id: String!, $folder: String!) { workspace(id: $id) { templateContext { requestedValues(requested: [\"folder_name\", \"folder.path\"], folderId: $folder, deferCreation: true) } } }",
        "variables": {"id":workspace,"folder":folder.id}
      })).await;
      assert_eq!(unplaced["errors"][0]["extensions"]["templateReason"], "folder-absent",
        "a real MCP destination is not an existing Core target placement: {unplaced}");
      organizer.create_link(workspace, myoxus_application::organizer::CreateOrganizerLink {
        id: Uuid::new_v4().to_string(), parent_id: folder.id.clone(),
        link_type: myoxus_application::organizer::OrganizerLinkType::Doc,
        target_id: external.clone(), target_workspace_id: None, index: None,
      }).await.expect("actual target placement");
      let placed = helpers::gql(&app, actor_session, json!({
        "query": "query($id: String!, $folder: String!, $target: String!) { workspace(id: $id) { templateContext { requestedValues(requested: [\"folder_name\", \"folder.path\"], targetDocId: $target, folderId: $folder, deferCreation: true) } } }",
        "variables": {"id":workspace,"folder":folder.id,"target":external}
      })).await;
      assert_eq!(placed["data"]["workspace"]["templateContext"]["requestedValues"]["folder_name"],
        "Real destination", "existing target context is preserved: {placed}");
      assert_eq!(placed["data"]["workspace"]["templateContext"]["requestedValues"]["folder.path"], "Top/Real destination");
      // An internal surrogate is not a public alias. A UUID-shaped external key
      // belongs to whichever document actually owns that key in this workspace.
      let surrogate = helpers::gql(
        &app,
        actor_session,
        query(&["creator.name"], Some(&doc.to_string()), false),
      )
      .await;
      assert_eq!(surrogate["errors"][0]["extensions"]["templateReason"], "metadata-unavailable");
      let uuid_key_doc = helpers::create_doc(&pool, workspace, actor).await;
      sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
        .bind(uuid_key_doc)
        .bind(doc.to_string())
        .execute(&pool)
        .await
        .expect("UUID-shaped external key owned by a different document");
      let uuid_key = helpers::gql(
        &app,
        actor_session,
        query(&["creator.name"], Some(&doc.to_string()), false),
      )
      .await;
      assert_eq!(
        uuid_key["data"]["workspace"]["templateContext"]["requestedValues"]["creator.name"],
        "Applying actor"
      );

      // Account fields are independent and lazy: an absent name must not block
      // an email-only read, but a requested empty value must fail explicitly.
      sqlx::query("UPDATE users SET name='   ' WHERE id=$1")
        .bind(creator)
        .execute(&pool)
        .await
        .expect("empty name fixture");
      let email = helpers::gql(&app, actor_session, query(&["creator.email"], Some(&external), false)).await;
      assert_eq!(
        email["data"]["workspace"]["templateContext"]["requestedValues"]["creator.email"],
        creator_email
      );
      let empty = helpers::gql(&app, actor_session, query(&["creator.name"], Some(&external), false)).await;
      assert_eq!(empty["errors"][0]["extensions"]["templateReason"], "empty-field");
      sqlx::query("UPDATE users SET name='Original creator' WHERE id=$1")
        .bind(creator)
        .execute(&pool)
        .await
        .expect("restore name");
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace)
        .bind(actor)
        .execute(&pool)
        .await
        .expect("deny UsersRead");
      let own_actor = helpers::gql(&app, actor_session, query(&["actor.name", "actor.email"], Some(&external), false)).await;
      assert_eq!(own_actor["data"]["workspace"]["templateContext"]["requestedValues"],
        json!({"actor.name":"Applying actor","actor.email":actor_email}),
        "own Auth facts do not grant member enumeration");
      sqlx::query("UPDATE users SET name='   ' WHERE id=$1").bind(actor).execute(&pool).await.expect("empty applying name");
      let own_email = helpers::gql(&app, actor_session, query(&["actor.email"], None, false)).await;
      assert_eq!(own_email["data"]["workspace"]["templateContext"]["requestedValues"]["actor.email"], actor_email);
      let absent_actor_name = helpers::gql(&app, actor_session, query(&["actor.name"], None, false)).await;
      assert_eq!(absent_actor_name["errors"][0]["extensions"]["templateReason"], "empty-field");
      sqlx::query("UPDATE users SET name='Applying actor' WHERE id=$1").bind(actor).execute(&pool).await.expect("restore applying name");
      let date = helpers::gql(
        &app,
        actor_session,
        query(&["document.created_at.time"], Some(&external), false),
      )
      .await;
      assert_eq!(
        date["data"]["workspace"]["templateContext"]["requestedValues"]["document.created_at.time"],
        created_at.to_rfc3339()
      );
      for names in [&["creator.name"][..], &["workspace.members"][..]] {
        let denied = helpers::gql(&app, actor_session, query(names, Some(&external), false)).await;
        assert_eq!(denied["errors"][0]["extensions"]["templateReason"], "member-fetch");
      }
      let before: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .expect("count before preflight");
      // Even a static template cannot bypass create/update permission preflight.
      for target in [None, Some(external.as_str())] {
        let denied = helpers::gql(&app, actor_session, query(&[], target, true)).await;
        assert!(denied.get("errors").is_some(), "write permission is required: {denied}");
      }
      sqlx::query("UPDATE workspace_memberships SET role='External' WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace)
        .bind(actor)
        .execute(&pool)
        .await
        .expect("document-specific editor fixture");
      sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Editor')")
        .bind(actor)
        .bind(doc)
        .execute(&pool)
        .await
        .expect("grant DocUpdate without UsersRead");
      let static_values = helpers::gql(&app, actor_session, query(&[], Some(&external), true)).await;
      assert_eq!(
        static_values["data"]["workspace"]["templateContext"]["requestedValues"],
        json!({})
      );
      let denied = helpers::gql(&app, actor_session, query(&["creator.name"], Some(&external), true)).await;
      assert_eq!(
        denied["errors"][0]["extensions"]["templateReason"], "member-fetch",
        "identity permission is checked even before target facts"
      );
      let unknown = helpers::gql(&app, creator_session, query(&["unknown"], None, true)).await;
      assert_eq!(
        unknown["errors"][0]["extensions"]["templateReason"],
        "unresolved-variable"
      );
      let after: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .expect("count after preflight");
      assert_eq!(before, after, "requested fact resolution is zero-write");
      })
      .catch_unwind()
      .await;
      helpers::cleanup_workspaces(&pool, &[workspace]).await;
      helpers::cleanup_users(&pool, &[creator, actor, pending]).await;
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    },
  );
}
#[async_trait]
impl OrganizationRepository for OrganizationFixture {
  async fn get_by_key(&self, key: &str) -> RepoResult<Option<Organization>> {
    assert_eq!(key, "myoxus");
    self.reads.fetch_add(1, Ordering::SeqCst);
    if self.fail {
      return Err(RepositoryError::Storage("private fixture detail".into()));
    }
    Ok(self.value.clone())
  }
  async fn get_by_id(&self, _: Uuid) -> RepoResult<Option<Organization>> {
    panic!("not a template context read")
  }
  async fn update(&self, _: Uuid, _: &str, _: &str, _: &serde_json::Value) -> RepoResult<Organization> {
    panic!("read-only context")
  }
}
struct LinkFixture {
  rows: Vec<OrganizationUnitWorkspace>,
  reads: AtomicUsize,
}
#[async_trait]
impl OrganizationUnitWorkspaceRepository for LinkFixture {
  async fn list_for_workspace(&self, _: Uuid) -> RepoResult<Vec<OrganizationUnitWorkspace>> {
    self.reads.fetch_add(1, Ordering::SeqCst);
    Ok(self.rows.clone())
  }
  async fn list_for_unit(&self, _: Uuid) -> RepoResult<Vec<OrganizationUnitWorkspace>> {
    panic!("wrong direction")
  }
  async fn get(
    &self,
    _: Uuid,
    _: Uuid,
    _: OrganizationUnitWorkspaceRelationship,
  ) -> RepoResult<Option<OrganizationUnitWorkspace>> {
    panic!("must check all owner rows")
  }
  async fn set_relationship(&self, _: Uuid, _: Uuid, _: OrganizationUnitWorkspaceRelationship) -> RepoResult<()> {
    panic!("read-only context")
  }
  async fn unassign(&self, _: Uuid, _: Uuid, _: OrganizationUnitWorkspaceRelationship) -> RepoResult<()> {
    panic!("read-only context")
  }
}

#[test]
fn workspace_template_context_is_authorized_lazy_and_owner_bound() {
  helpers::block_on_large_stack(
    "workspace_template_context_is_authorized_lazy_and_owner_bound",
    || async {
      let (app, pool, auth) = helpers::setup_app().await;
      let (reader, session) = helpers::seed_user(&pool, &auth, "template-context-reader").await;
      let (outsider, outsider_session) = helpers::seed_user(&pool, &auth, "template-context-outsider").await;
      let organization = helpers::default_organization_id(&pool).await;
      let expected_name: String = sqlx::query_scalar("SELECT name FROM organization WHERE id = $1")
        .bind(organization)
        .fetch_one(&pool)
        .await
        .expect("organization name");
      let kind = helpers::preset_unit_type_id(&pool, "team").await;
      let owner = helpers::create_organization_unit(&pool, organization, kind, None, " Template owner ").await;
      let other = helpers::create_organization_unit(&pool, organization, kind, None, "Not the owner").await;
      let workspace = Uuid::new_v4();
      sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public, owner_principal_type, owner_principal_id, management_unit_id, created_by_user_id) VALUES ($1, NULL, 'Template context fixture', FALSE, 'ou', $2, $2, $3)")
      .bind(workspace).bind(owner).bind(reader).execute(&pool).await.expect("workspace fixture");
      sqlx::query("INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship) VALUES ($1, $3, 'owner'), ($2, $3, 'linked')")
      .bind(owner).bind(other).bind(workspace).execute(&pool).await.expect("owner and unrelated link");
      sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Reader', 'Accepted', now())")
      .bind(workspace).bind(reader).execute(&pool).await.expect("ordinary reader, no OU membership");
      let query = |id: Uuid, unit: bool| {
        json!({
          "query": "query($id: String!, $unit: Boolean!) { workspace(id: $id) { templateContext { organizationName owner: organizationUnitName @include(if: $unit) } } }",
          "variables": { "id": id, "unit": unit }
        })
      };
      let result = helpers::gql(&app, session, query(workspace, true)).await;
      assert!(result.get("errors").is_none(), "{result}");
      assert_eq!(
        result["data"]["workspace"]["templateContext"],
        json!({"organizationName": expected_name.trim(), "owner": "Template owner"})
      );
      let denied = helpers::gql(&app, outsider_session, query(workspace, true)).await;
      assert!(denied.get("errors").is_some(), "Workspace Read must fail: {denied}");
      assert!(denied["data"]["workspace"].is_null());

      use myoxus_application::organization::OrganizationTemplateContextService;
      use myoxus_infrastructure::{
        organization::{PgOrganizationRepository, PgOrganizationUnitRepository, PgOrganizationUnitWorkspaceRepository},
        workspace::SqlxWorkspaceStore,
      };
      let rows = PgOrganizationUnitWorkspaceRepository::new(pool.clone())
        .list_for_workspace(workspace)
        .await
        .expect("fixture links");
      let organization_record = PgOrganizationRepository::new(pool.clone())
        .get_by_key("myoxus")
        .await
        .expect("fixture organization")
        .unwrap();
      for (value, fail) in [
        (None, false),
        (
          Some(Organization {
            name: "   ".into(),
            ..organization_record.clone()
          }),
          false,
        ),
        (None, true),
      ] {
        let organizations = Arc::new(OrganizationFixture {
          value,
          fail,
          reads: AtomicUsize::new(0),
        });
        let links = Arc::new(LinkFixture {
          rows: rows.clone(),
          reads: AtomicUsize::new(0),
        });
        let service = OrganizationTemplateContextService::new(
          Arc::new(SqlxWorkspaceStore::new(
            pool.clone(),
            crate::helpers::database_starter_catalog(),
          )),
          organizations.clone(),
          links.clone(),
          Arc::new(PgOrganizationUnitRepository::new(pool.clone())),
        );
        let unit = service
          .resolve(workspace, false, true)
          .await
          .expect("unrequested organization cannot fail valid OU");
        assert_eq!(unit.organization_unit_name.as_deref(), Some("Template owner"));
        assert_eq!(organizations.reads.load(Ordering::SeqCst), 0);
        let result = service.resolve(workspace, true, false).await;
        if fail {
          assert_eq!(
            result.err().expect("transport failure").to_string(),
            "storage failure: organization template context unavailable"
          );
        } else {
          assert!(result.unwrap().organization_name.is_none());
        }
        assert_eq!(
          links.reads.load(Ordering::SeqCst),
          1,
          "organization-only must not read links"
        );
      }
      let mut duplicate_rows = rows.clone();
      duplicate_rows.push(
        rows
          .iter()
          .find(|row| row.relationship == OrganizationUnitWorkspaceRelationship::Owner)
          .unwrap()
          .clone(),
      );
      let service = OrganizationTemplateContextService::new(
        Arc::new(SqlxWorkspaceStore::new(
          pool.clone(),
          crate::helpers::database_starter_catalog(),
        )),
        Arc::new(PgOrganizationRepository::new(pool.clone())),
        Arc::new(LinkFixture {
          rows: duplicate_rows,
          reads: AtomicUsize::new(0),
        }),
        Arc::new(PgOrganizationUnitRepository::new(pool.clone())),
      );
      let corrupt = service
        .resolve(workspace, true, true)
        .await
        .expect("corrupt owner is nullable");
      assert_eq!(corrupt.organization_name.as_deref(), Some(expected_name.trim()));
      assert!(corrupt.organization_unit_name.is_none());

      sqlx::query("UPDATE organization_unit SET name = '   ' WHERE id = $1")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("empty owner name fixture");
      let empty = helpers::gql(&app, session, query(workspace, true)).await;
      assert!(empty.get("errors").is_none(), "{empty}");
      assert_eq!(
        empty["data"]["workspace"]["templateContext"],
        json!({"organizationName": expected_name.trim(), "owner": null})
      );
      sqlx::query("UPDATE organization_unit SET name = 'Template owner' WHERE id = $1")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("restore own fixture name");

      // A valid principal referencing another OU does not make its unrelated link
      // an owner. No schema constraints are disabled to model this disagreement.
      sqlx::query("UPDATE workspaces SET owner_principal_id = $2 WHERE id = $1")
        .bind(workspace)
        .bind(other)
        .execute(&pool)
        .await
        .expect("mismatched principal fixture");
      let mismatch = helpers::gql(&app, session, query(workspace, true)).await;
      assert!(mismatch.get("errors").is_none(), "{mismatch}");
      assert_eq!(
        mismatch["data"]["workspace"]["templateContext"],
        json!({"organizationName": expected_name.trim(), "owner": null})
      );
      let lazy = helpers::gql(&app, session, query(workspace, false)).await;
      assert_eq!(
        lazy["data"]["workspace"]["templateContext"],
        json!({"organizationName": expected_name.trim()})
      );
      let personal = helpers::create_workspace(&pool, reader).await;
      let personal_result = helpers::gql(&app, session, query(personal, true)).await;
      assert_eq!(
        personal_result["data"]["workspace"]["templateContext"],
        json!({"organizationName": expected_name.trim(), "owner": null})
      );

      helpers::cleanup_workspaces(&pool, &[workspace, personal]).await;
      helpers::cleanup_organization_units(&pool, &[owner, other]).await;
      helpers::cleanup_users(&pool, &[reader, outsider]).await;
    },
  );
}
