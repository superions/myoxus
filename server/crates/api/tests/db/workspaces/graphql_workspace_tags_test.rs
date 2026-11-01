//! End-to-end invariants for the authoritative workspace tag GraphQL contract.

use chrono::Utc;
use myoxus_domain::database::{Database, DatabaseJsonImportMode};
use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseImportExportRepository};
use myoxus_domain::repositories::RepositoryError;
use myoxus_domain::workspace_tags::{WorkspaceTag, WorkspaceTagColorRole, WorkspaceTagRepository};
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use myoxus_infrastructure::workspace_tags::PgWorkspaceTagRepository;
use serde_json::{Value, json};
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, Map, ReadTxn, StateVector, Transact, Update};

use crate::helpers;

fn data<'a>(response: &'a Value, path: &[&str]) -> &'a Value {
  assert!(
    response.get("errors").is_none(),
    "unexpected GraphQL errors: {response:#}"
  );
  path.iter().fold(&response["data"], |value, segment| &value[*segment])
}

fn error_code(response: &Value) -> &str {
  response["errors"][0]["extensions"]["code"]
    .as_str()
    .unwrap_or_else(|| panic!("missing workspace tag error code: {response:#}"))
}

fn workspace_root_tag_fixture(options: &[String], pages: &[(String, Vec<String>)]) -> Vec<u8> {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  {
    let mut txn = doc.transact_mut();
    let properties = meta.insert(&mut txn, "properties", yrs::MapPrelim::default());
    let tags = properties.insert(&mut txn, "tags", yrs::MapPrelim::default());
    let tag_options = tags.insert(&mut txn, "options", yrs::ArrayPrelim::default());
    for id in options {
      tag_options.push_back(
        &mut txn,
        yrs::MapPrelim::from([("id".to_string(), Any::String(id.clone().into()))]),
      );
    }
    let root_pages = meta.insert(&mut txn, "pages", yrs::ArrayPrelim::default());
    for (id, tag_ids) in pages {
      let page = root_pages.push_back(
        &mut txn,
        yrs::MapPrelim::from([("id".to_string(), Any::String(id.clone().into()))]),
      );
      let tags = page.insert(&mut txn, "tags", yrs::ArrayPrelim::default());
      for tag_id in tag_ids {
        tags.push_back(&mut txn, Any::String(tag_id.clone().into()));
      }
    }
  }
  doc.transact().encode_state_as_update_v1(&StateVector::default())
}

fn workspace_root_tag_ids(update: &[u8]) -> (Vec<String>, Vec<Vec<String>>) {
  let doc = Doc::new();
  let meta = doc.get_or_insert_map("meta");
  doc
    .transact_mut()
    .apply_update(Update::decode_v1(update).expect("decode root Tag fixture"))
    .expect("apply root Tag fixture");
  let txn = doc.transact();
  let options = match meta.get(&txn, "properties") {
    Some(yrs::Out::YMap(properties)) => match properties.get(&txn, "tags") {
      Some(yrs::Out::YMap(tags)) => match tags.get(&txn, "options") {
        Some(yrs::Out::YArray(options)) => options
          .iter(&txn)
          .filter_map(|option| match option {
            yrs::Out::YMap(option) => match option.get(&txn, "id") {
              Some(yrs::Out::Any(Any::String(id))) => Some(id.to_string()),
              _ => None,
            },
            _ => None,
          })
          .collect(),
        _ => Vec::new(),
      },
      _ => Vec::new(),
    },
    _ => Vec::new(),
  };
  let pages = match meta.get(&txn, "pages") {
    Some(yrs::Out::YArray(pages)) => pages
      .iter(&txn)
      .filter_map(|page| match page {
        yrs::Out::YMap(page) => match page.get(&txn, "tags") {
          Some(yrs::Out::YArray(tags)) => Some(
            tags
              .iter(&txn)
              .filter_map(|tag| match tag {
                yrs::Out::Any(Any::String(id)) => Some(id.to_string()),
                _ => None,
              })
              .collect(),
          ),
          _ => None,
        },
        _ => None,
      })
      .collect(),
    _ => Vec::new(),
  };
  (options, pages)
}

async fn create_tag(
  app: &axum::Router,
  session: Uuid,
  workspace_id: Uuid,
  name: &str,
  color_role: &str,
  description: Option<&str>,
) -> Value {
  helpers::gql(
    app,
    session,
    json!({
      "query": "mutation($input: CreateWorkspaceTagInput!) { createWorkspaceTag(input: $input) { id name slug colorRole description archived } }",
      "variables": { "input": { "workspaceId": workspace_id, "name": name, "colorRole": color_role, "description": description } }
    }),
  )
  .await
}

async fn document_search_tuple(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid) -> (String, Value) {
  sqlx::query_as("SELECT xmin::text, workspace_tags FROM search_content WHERE workspace_id = $1 AND doc_id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(pool)
    .await
    .expect("read document search tuple")
}

async fn row_search_tuple(pool: &sqlx::PgPool, workspace_id: Uuid, row_id: Uuid) -> (String, Value) {
  sqlx::query_as(
    "SELECT xmin::text, workspace_tags FROM workspace_database_row_search WHERE workspace_id = $1 AND row_id = $2",
  )
  .bind(workspace_id)
  .bind(row_id)
  .fetch_one(pool)
  .await
  .expect("read Database row search tuple")
}

#[test]
fn workspace_tags_share_one_acl_scoped_catalog_with_document_assignments_and_legacy_bootstrap() {
  helpers::block_on_large_stack("workspace-tags-authoritative-catalog", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    helpers::create_workspace_root_doc(&pool, workspace_id, owner_id).await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

    let first_response = create_tag(
      &app,
      owner_session,
      workspace_id,
      "Release Ready",
      "tag.blue",
      Some("  Coordinates the complete release handoff.  "),
    )
    .await;
    let first = data(&first_response, &["createWorkspaceTag"]);
    let first_id = first["id"].as_str().expect("first tag id").to_string();
    assert_eq!(first["slug"], "release-ready");
    assert_eq!(first["colorRole"], "tag.blue");
    assert_eq!(first["description"], "Coordinates the complete release handoff.");

    let description_read = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "query($workspaceId: String!) { workspace(id: $workspaceId) { workspaceTags { id description } } }",
        "variables": { "workspaceId": workspace_id }
      }),
    )
    .await;
    let description_read = data(&description_read, &["workspace", "workspaceTags"])
      .as_array()
      .expect("workspace Tags");
    assert!(
      description_read
        .iter()
        .any(|tag| { tag["id"] == first_id && tag["description"] == "Coordinates the complete release handoff." })
    );

    let description_update = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: UpdateWorkspaceTagDescriptionInput!) { updateWorkspaceTagDescription(input: $input) { id description } }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": first_id, "description": "  Release handoff and verification.  " } }
      }),
    )
    .await;
    assert_eq!(
      data(&description_update, &["updateWorkspaceTagDescription", "description"]),
      "Release handoff and verification."
    );

    let second_response = create_tag(&app, owner_session, workspace_id, "Release Ready", "tag.green", None).await;
    let second = data(&second_response, &["createWorkspaceTag"]);
    let second_id = second["id"].as_str().expect("second tag id").to_string();
    assert_eq!(second["slug"], "release-ready-2");

    let invalid_color = create_tag(&app, owner_session, workspace_id, "Invalid color", "#ff0000", None).await;
    assert_eq!(error_code(&invalid_color), "MIX_WORKSPACE_TAG_INVALID_COLOR");

    let assignment = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: SetDocumentWorkspaceTagsInput!) { setDocumentWorkspaceTags(input: $input) }",
        "variables": { "input": { "workspaceId": workspace_id, "docId": doc_id, "tagIds": [first_id, second_id] } }
      }),
    )
    .await;
    assert_eq!(
      data(&assignment, &["setDocumentWorkspaceTags"]),
      &json!([first_id, second_id])
    );
    let initial_search_tags = json!([
      { "id": first_id, "name": "Release Ready", "slug": "release-ready", "colorRole": "tag.blue" },
      { "id": second_id, "name": "Release Ready", "slug": "release-ready-2", "colorRole": "tag.green" }
    ]);
    sqlx::query(
      r#"
      INSERT INTO search_content
        (workspace_id, doc_id, title, plain_text, workspace_tags, search_vector, updated_at)
      VALUES ($1, $2, 'Tagged document', 'search body', $3,
              to_tsvector('simple', 'Tagged document search body ' || $3::text), now())
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(&initial_search_tags)
    .execute(&pool)
    .await
    .expect("seed tagged search content");

    let archived = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: WorkspaceTagLifecycleInput!) { archiveWorkspaceTag(input: $input) { id archived } }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": first_id } }
      }),
    )
    .await;
    assert_eq!(data(&archived, &["archiveWorkspaceTag", "archived"]), true);

    let retained_archived = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: SetDocumentWorkspaceTagsInput!) { setDocumentWorkspaceTags(input: $input) }",
        "variables": { "input": { "workspaceId": workspace_id, "docId": doc_id, "tagIds": [first_id] } }
      }),
    )
    .await;
    assert_eq!(
      data(&retained_archived, &["setDocumentWorkspaceTags"]),
      &json!([first_id])
    );

    let copied_doc = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let copy = |ids: Value| {
      json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace_id,"docId":copied_doc,"copyFromDocId":doc_id,"tagIds":ids}}
      })
    };
    let copied = helpers::gql(&app, owner_session, copy(json!([first_id]))).await;
    assert_eq!(
      data(&copied, &["setDocumentWorkspaceTags"]),
      &json!([first_id]),
      "explicit copy retains archived source identity"
    );
    let stale_copy = helpers::gql(&app, owner_session, copy(json!([]))).await;
    assert!(
      stale_copy.get("errors").is_some(),
      "a changed source must reject copying"
    );
    let copied_ids: Vec<Uuid> =
      sqlx::query_scalar("SELECT tag_id FROM workspace_tag_document_assignments WHERE doc_id=$1 ORDER BY position")
        .bind(copied_doc)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(copied_ids, vec![Uuid::parse_str(&first_id).unwrap()]);
    sqlx::query("DELETE FROM docs WHERE id=$1")
      .bind(copied_doc)
      .execute(&pool)
      .await
      .unwrap();

    let removed_archived = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: SetDocumentWorkspaceTagsInput!) { setDocumentWorkspaceTags(input: $input) }",
        "variables": { "input": { "workspaceId": workspace_id, "docId": doc_id, "tagIds": [second_id] } }
      }),
    )
    .await;
    assert_eq!(
      data(&removed_archived, &["setDocumentWorkspaceTags"]),
      &json!([second_id])
    );

    let archived_write = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: SetDocumentWorkspaceTagsInput!) { setDocumentWorkspaceTags(input: $input) }",
        "variables": { "input": { "workspaceId": workspace_id, "docId": doc_id, "tagIds": [first_id, second_id] } }
      }),
    )
    .await;
    assert_eq!(error_code(&archived_write), "MIX_WORKSPACE_TAG_ARCHIVED_WRITE");

    let rename = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: RenameWorkspaceTagInput!) { renameWorkspaceTag(input: $input) { id slug } }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": second_id, "name": "Release Ready" } }
      }),
    )
    .await;
    assert_eq!(data(&rename, &["renameWorkspaceTag", "slug"]), "release-ready");
    let projection: Value =
      sqlx::query_scalar("SELECT workspace_tags FROM search_content WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_one(&pool)
        .await
        .expect("read refreshed canonical search projection");
    let projected = projection.as_array().expect("structured workspace tags");
    assert!(
      projected
        .iter()
        .any(|tag| tag["id"] == second_id && tag["slug"] == "release-ready")
    );
    assert!(!projected.iter().any(|tag| tag["slug"] == "release-ready-2"));

    let blocked_restore = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: WorkspaceTagLifecycleInput!) { restoreWorkspaceTag(input: $input) { id } }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": first_id } }
      }),
    )
    .await;
    assert_eq!(error_code(&blocked_restore), "MIX_WORKSPACE_TAG_DUPLICATE_SLUG");

    let legacy_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let bootstrap_input = json!({
      "workspaceId": workspace_id,
      "tags": [{ "legacyId": "legacy-priority", "name": "Priority", "color": "#ed3f3f" }],
      "assignments": [{ "docId": legacy_doc_id, "legacyTagIds": ["legacy-priority"] }]
    });
    let bootstrap = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "mutation($input: BootstrapWorkspaceTagsInput!) { bootstrapWorkspaceTags(input: $input) { tags { id name colorRole } legacyIdMappings { legacyId tagId } colorNormalizations { legacyId sourceColor colorRole normalized } importedTags reusedTags importedAssignments } }",
      "variables": { "input": bootstrap_input.clone() }
    }),
  )
  .await;
    assert_eq!(error_code(&bootstrap), "WORKSPACE_TAG_BOOTSTRAP_RETIRED");
    let unchanged: i64 =
      sqlx::query_scalar("SELECT count(*) FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2")
        .bind(workspace_id)
        .bind(legacy_doc_id)
        .fetch_one(&pool)
        .await
        .expect("bootstrap must not assign");
    assert_eq!(unchanged, 0);
    // Model a shipped catalog/mapping fixture explicitly. Bootstrap is retired;
    // ordinary catalog writes and historical persisted mappings remain live.
    let legacy = create_tag(&app, owner_session, workspace_id, "Priority", "tag.red", None).await;
    let legacy_tag_id = data(&legacy, &["createWorkspaceTag", "id"])
      .as_str()
      .unwrap()
      .to_owned();
    sqlx::query("INSERT INTO workspace_tag_legacy_ids(workspace_id,legacy_id,tag_id) VALUES($1,'legacy-priority',$2)")
      .bind(workspace_id)
      .bind(Uuid::parse_str(&legacy_tag_id).unwrap())
      .execute(&pool)
      .await
      .unwrap();
    let assigned = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace_id,"docId":legacy_doc_id,"tagIds":[legacy_tag_id]}}
      }),
    )
    .await;
    assert_eq!(data(&assigned, &["setDocumentWorkspaceTags"]), &json!([legacy_tag_id]));
    let repeated = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:BootstrapWorkspaceTagsInput!){bootstrapWorkspaceTags(input:$input){importedTags}}",
        "variables":{"input":bootstrap_input.clone()}
      }),
    )
    .await;
    assert_eq!(error_code(&repeated), "WORKSPACE_TAG_BOOTSTRAP_RETIRED");

    let assignment_query = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query($workspaceId: String!, $docId: ID!) { workspace(id: $workspaceId) { documentWorkspaceTagIds(docId: $docId) } }",
      "variables": { "workspaceId": workspace_id, "docId": legacy_doc_id }
    }),
  )
  .await;
    assert_eq!(
      data(&assignment_query, &["workspace", "documentWorkspaceTagIds"]),
      &json!([legacy_tag_id])
    );

    for (assigned_doc_id, tag_ids) in [
      (doc_id, json!([second_id, legacy_tag_id])),
      (legacy_doc_id, json!([legacy_tag_id, second_id])),
    ] {
      let assignment = helpers::gql(
        &app,
        owner_session,
        json!({
          "query": "mutation($input: SetDocumentWorkspaceTagsInput!) { setDocumentWorkspaceTags(input: $input) }",
          "variables": { "input": { "workspaceId": workspace_id, "docId": assigned_doc_id, "tagIds": tag_ids } }
        }),
      )
      .await;
      data(&assignment, &["setDocumentWorkspaceTags"]);
    }
    let root_fixture = workspace_root_tag_fixture(
      &[second_id.clone(), legacy_tag_id.clone()],
      &[
        (doc_id.to_string(), vec![second_id.clone(), legacy_tag_id.clone()]),
        (
          legacy_doc_id.to_string(),
          vec![legacy_tag_id.clone(), second_id.clone()],
        ),
      ],
    );
    sqlx::query("INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence) VALUES ($1, $1, $2, 1)")
      .bind(workspace_id)
      .bind(root_fixture)
      .execute(&pool)
      .await
      .expect("seed root Tag compatibility projection");

    let archived_tag_id = Uuid::parse_str(&first_id).expect("archived tag uuid");
    let legacy_tag_uuid = Uuid::parse_str(&legacy_tag_id).expect("legacy canonical Tag uuid");
    let second_tag_uuid = Uuid::parse_str(&second_id).expect("surviving Tag uuid");
    let active_database_id = Uuid::new_v4();
    let trashed_database_id = Uuid::new_v4();
    let active_field_id = Uuid::new_v4();
    let second_active_field_id = Uuid::new_v4();
    let trashed_field_id = Uuid::new_v4();
    let active_row_id = Uuid::new_v4();
    let deleted_row_id = Uuid::new_v4();
    let trashed_database_row_id = Uuid::new_v4();
    sqlx::query(
      r#"
        INSERT INTO workspace_databases
          (id, workspace_id, title, created_by, updated_by, deleted_at, deleted_by)
        VALUES
          ($1, $3, 'Active tagged Database', $4, $4, NULL, NULL),
          ($2, $3, 'Trashed tagged Database', $4, $4, now(), $4)
      "#,
    )
    .bind(active_database_id)
    .bind(trashed_database_id)
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed tagged databases");
    sqlx::query(
      r#"
        INSERT INTO workspace_database_fields
          (id, database_id, name, field_type, config_json, position, required)
        VALUES
          ($1, $4, 'Tags', 'tags', '{"kind":"tags"}', 0, false),
          ($2, $4, 'Secondary Tags', 'tags', '{"kind":"tags"}', 1, false),
          ($3, $5, 'Tags', 'tags', '{"kind":"tags"}', 0, false)
      "#,
    )
    .bind(active_field_id)
    .bind(second_active_field_id)
    .bind(trashed_field_id)
    .bind(active_database_id)
    .bind(trashed_database_id)
    .execute(&pool)
    .await
    .expect("seed tag fields");
    sqlx::query(
      r#"
        INSERT INTO workspace_database_rows
          (id, database_id, title, position, created_by, updated_by, deleted_at)
        VALUES
          ($1, $4, 'Visible tagged row', 0, $6, $6, NULL),
          ($2, $4, 'Deleted tagged row', 1, $6, $6, now()),
          ($3, $5, 'Row in trashed Database', 0, $6, $6, NULL)
      "#,
    )
    .bind(active_row_id)
    .bind(deleted_row_id)
    .bind(trashed_database_row_id)
    .bind(active_database_id)
    .bind(trashed_database_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed tagged rows");
    for (row_id, field_id, database_id) in [
      (active_row_id, active_field_id, active_database_id),
      (active_row_id, second_active_field_id, active_database_id),
      (deleted_row_id, active_field_id, active_database_id),
      (trashed_database_row_id, trashed_field_id, trashed_database_id),
    ] {
      sqlx::query(
        "INSERT INTO workspace_database_cell_values \
          (row_id, field_id, database_id, value_json, updated_by) \
         VALUES ($1, $2, $3, $4, $5)",
      )
      .bind(row_id)
      .bind(field_id)
      .bind(database_id)
      .bind(json!([
        archived_tag_id,
        legacy_tag_uuid,
        second_tag_uuid,
        legacy_tag_uuid
      ]))
      .bind(owner_id)
      .execute(&pool)
      .await
      .expect("seed tag cell");
    }

    let usage_query = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "query($workspaceId: String!, $tagId: ID!) { workspace(id: $workspaceId) { workspaceTagDatabaseRowUsages(tagId: $tagId) { databaseId databaseTitle rowId rowTitle } } }",
        "variables": { "workspaceId": workspace_id, "tagId": archived_tag_id }
      }),
    )
    .await;
    let usages = data(&usage_query, &["workspace", "workspaceTagDatabaseRowUsages"])
      .as_array()
      .expect("database row tag usages");
    assert_eq!(
      usages,
      &[json!({
        "databaseId": active_database_id,
        "databaseTitle": "Active tagged Database",
        "rowId": active_row_id,
        "rowTitle": "Visible tagged row"
      })],
      "archived Tags remain readable while duplicate references, deleted Rows and trashed Databases stay hidden"
    );

    let catalog_query = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "query($workspaceId: String!, $includeArchived: Boolean) { workspace(id: $workspaceId) { workspaceTagCatalog(includeArchived: $includeArchived) { tag { id description archived } documentCount databaseRowCount } } }",
        "variables": { "workspaceId": workspace_id, "includeArchived": true }
      }),
    )
    .await;
    let catalog = data(&catalog_query, &["workspace", "workspaceTagCatalog"])
      .as_array()
      .expect("workspace Tag catalog");
    let archived_entry = catalog
      .iter()
      .find(|entry| entry["tag"]["id"] == first_id)
      .expect("archived catalog entry");
    assert_eq!(
      archived_entry["tag"]["description"],
      "Release handoff and verification."
    );
    assert_eq!(archived_entry["documentCount"], 0);
    assert_eq!(archived_entry["databaseRowCount"], 1);
    let active_entry = catalog
      .iter()
      .find(|entry| entry["tag"]["id"] == second_id)
      .expect("active catalog entry");
    assert_eq!(active_entry["documentCount"], 2);
    assert_eq!(active_entry["databaseRowCount"], 1);
    let legacy_entry = catalog
      .iter()
      .find(|entry| entry["tag"]["id"] == legacy_tag_id)
      .expect("legacy catalog entry");
    assert_eq!(legacy_entry["documentCount"], 2);
    assert_eq!(legacy_entry["databaseRowCount"], 1);

    let active_catalog_query = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "query($workspaceId: String!) { workspace(id: $workspaceId) { workspaceTagCatalog { tag { id archived } } } }",
        "variables": { "workspaceId": workspace_id }
      }),
    )
    .await;
    let active_catalog = data(&active_catalog_query, &["workspace", "workspaceTagCatalog"])
      .as_array()
      .expect("active workspace Tag catalog");
    assert!(active_catalog.iter().all(|entry| entry["tag"]["archived"] == false));
    assert!(!active_catalog.iter().any(|entry| entry["tag"]["id"] == first_id));

    let active_delete = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: WorkspaceTagLifecycleInput!) { deleteWorkspaceTagPermanently(input: $input) }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": legacy_tag_id } }
      }),
    )
    .await;
    assert_eq!(error_code(&active_delete), "MIX_WORKSPACE_TAG_NOT_ARCHIVED");

    let archive_target = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: WorkspaceTagLifecycleInput!) { archiveWorkspaceTag(input: $input) { id archived } }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": legacy_tag_id } }
      }),
    )
    .await;
    assert_eq!(data(&archive_target, &["archiveWorkspaceTag", "archived"]), true);
    let deleted = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: WorkspaceTagLifecycleInput!) { deleteWorkspaceTagPermanently(input: $input) }",
        "variables": { "input": { "workspaceId": workspace_id, "tagId": legacy_tag_id } }
      }),
    )
    .await;
    assert_eq!(data(&deleted, &["deleteWorkspaceTagPermanently"]), true);

    for assigned_doc_id in [doc_id, legacy_doc_id] {
      let remaining: Vec<Uuid> = sqlx::query_scalar(
        "SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id = $1 AND doc_id = $2 ORDER BY position",
      )
      .bind(workspace_id)
      .bind(assigned_doc_id)
      .fetch_all(&pool)
      .await
      .expect("read remaining ordered document Tags");
      assert_eq!(remaining, vec![second_tag_uuid]);
    }
    let remaining_cells: Vec<Value> = sqlx::query_scalar(
      "SELECT cell.value_json FROM workspace_database_cell_values cell JOIN workspace_databases database ON database.id = cell.database_id WHERE database.workspace_id = $1 ORDER BY cell.database_id, cell.row_id, cell.field_id",
    )
    .bind(workspace_id)
    .fetch_all(&pool)
    .await
    .expect("read cleaned Database Tag cells");
    assert!(
      remaining_cells
        .iter()
        .all(|value| { value == &json!([archived_tag_id, second_tag_uuid]) })
    );
    let root_updates: Vec<Vec<u8>> =
      sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1 ORDER BY sequence")
        .bind(workspace_id)
        .fetch_all(&pool)
        .await
        .expect("read root Tag cleanup updates");
    let root_state = yjs::merge_updates(root_updates).expect("merge root Tag cleanup updates");
    let (root_options, root_pages) = workspace_root_tag_ids(&root_state);
    assert_eq!(root_options, vec![second_id.clone()]);
    assert_eq!(root_pages, vec![vec![second_id.clone()], vec![second_id.clone()]]);
    let retired_ids: Vec<String> = sqlx::query_scalar(
      "SELECT retired_tag_id FROM workspace_tag_retired_ids WHERE workspace_id = $1 ORDER BY retired_tag_id",
    )
    .bind(workspace_id)
    .fetch_all(&pool)
    .await
    .expect("read retired Tag identities");
    assert_eq!(retired_ids, vec![legacy_tag_id.clone(), "legacy-priority".to_string()]);

    let stale_bootstrap = helpers::gql(
      &app,
      owner_session,
      json!({
        "query": "mutation($input: BootstrapWorkspaceTagsInput!) { bootstrapWorkspaceTags(input: $input) { importedTags reusedTags importedAssignments tags { id } } }",
        "variables": { "input": {
          "workspaceId": workspace_id,
          "tags": bootstrap_input["tags"].clone(),
          "assignments": [{ "docId": legacy_doc_id, "legacyTagIds": ["legacy-priority", second_id] }]
        } }
      }),
    )
    .await;
    assert_eq!(error_code(&stale_bootstrap), "WORKSPACE_TAG_BOOTSTRAP_RETIRED");
    let unchanged: Vec<Uuid> = sqlx::query_scalar(
      "SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2 ORDER BY position",
    )
    .bind(workspace_id)
    .bind(legacy_doc_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
      unchanged,
      vec![second_tag_uuid],
      "stale bootstrap must not resurrect or replace SQL labels"
    );

    let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let cross_workspace = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query($workspaceId: String!, $tagIds: [ID!]!) { workspace(id: $workspaceId) { resolveWorkspaceTags(tagIds: $tagIds) { id } } }",
      "variables": { "workspaceId": other_workspace_id, "tagIds": [legacy_tag_id] }
    }),
  )
  .await;
    assert_eq!(error_code(&cross_workspace), "MIX_WORKSPACE_TAG_CROSS_WORKSPACE");

    helpers::cleanup_workspaces(&pool, &[workspace_id, other_workspace_id]).await;
    helpers::cleanup_users(&pool, &[owner_id]).await;
  });
}

#[test]
fn workspace_tag_search_refreshes_only_affected_projection_tuples() {
  helpers::block_on_large_stack("workspace-tag-search-refresh-scope", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let other_workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let tagged_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let unrelated_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let other_doc_id = helpers::create_doc(&pool, other_workspace_id, owner_id).await;

    for (candidate_workspace_id, doc_id, title) in [
      (workspace_id, tagged_doc_id, "Affected document"),
      (workspace_id, unrelated_doc_id, "Unrelated document"),
      (other_workspace_id, other_doc_id, "Other Workspace document"),
    ] {
      sqlx::query(
        "INSERT INTO search_content(workspace_id,doc_id,title,plain_text,workspace_tags,search_vector) \
         VALUES($1,$2,$3,'body','[]',to_tsvector('simple',$3 || ' body'))",
      )
      .bind(candidate_workspace_id)
      .bind(doc_id)
      .bind(title)
      .execute(&pool)
      .await
      .expect("seed document search tuple");
    }

    let database_id = Uuid::new_v4();
    let other_database_id = Uuid::new_v4();
    let tag_field_id = Uuid::new_v4();
    let unrelated_field_id = Uuid::new_v4();
    let other_field_id = Uuid::new_v4();
    let tagged_row_id = Uuid::new_v4();
    let unrelated_row_id = Uuid::new_v4();
    let other_row_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO workspace_databases(id,workspace_id,title,created_by,updated_by) VALUES \
       ($1,$3,'Scoped refresh',$4,$4),($2,$5,'Other Workspace scoped refresh',$4,$4)",
    )
    .bind(database_id)
    .bind(other_database_id)
    .bind(workspace_id)
    .bind(owner_id)
    .bind(other_workspace_id)
    .execute(&pool)
    .await
    .expect("seed scoped refresh Databases");
    sqlx::query(
      "INSERT INTO workspace_database_fields(id,database_id,name,field_type,config_json,position,required) VALUES \
       ($1,$4,'Tags','tags','{\"kind\":\"tags\"}',0,false), \
       ($2,$4,'Other tags','tags','{\"kind\":\"tags\"}',1,false), \
       ($3,$5,'Tags','tags','{\"kind\":\"tags\"}',0,false)",
    )
    .bind(tag_field_id)
    .bind(unrelated_field_id)
    .bind(other_field_id)
    .bind(database_id)
    .bind(other_database_id)
    .execute(&pool)
    .await
    .expect("seed scoped refresh fields");
    sqlx::query(
      "INSERT INTO workspace_database_rows(id,database_id,title,position,created_by,updated_by) VALUES \
       ($1,$4,'Affected row',0,$6,$6),($2,$4,'Unrelated row',1,$6,$6),($3,$5,'Other Workspace row',0,$6,$6)",
    )
    .bind(tagged_row_id)
    .bind(unrelated_row_id)
    .bind(other_row_id)
    .bind(database_id)
    .bind(other_database_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed scoped refresh rows");
    for (candidate_workspace_id, candidate_database_id, row_id, title) in [
      (workspace_id, database_id, tagged_row_id, "Affected row"),
      (workspace_id, database_id, unrelated_row_id, "Unrelated row"),
      (
        other_workspace_id,
        other_database_id,
        other_row_id,
        "Other Workspace row",
      ),
    ] {
      sqlx::query(
        "INSERT INTO workspace_database_row_search(workspace_id,database_id,row_id,title,search_text,workspace_tags) \
         VALUES($1,$2,$3,$4,'body','[]')",
      )
      .bind(candidate_workspace_id)
      .bind(candidate_database_id)
      .bind(row_id)
      .bind(title)
      .execute(&pool)
      .await
      .expect("seed Database row search tuple");
    }

    let created = create_tag(&app, owner_session, workspace_id, "Scoped old", "tag.blue", None).await;
    let tag_id = data(&created, &["createWorkspaceTag", "id"])
      .as_str()
      .expect("created Tag id")
      .to_owned();
    let tag_uuid = Uuid::parse_str(&tag_id).expect("created Tag UUID");
    sqlx::query(
      "INSERT INTO workspace_database_cell_values(row_id,field_id,database_id,value_json,updated_by) \
       VALUES($1,$2,$3,$4,$5),($6,$7,$3,'[]',$5),($8,$9,$10,'[]',$5)",
    )
    .bind(tagged_row_id)
    .bind(tag_field_id)
    .bind(database_id)
    .bind(json!([tag_uuid]))
    .bind(owner_id)
    .bind(unrelated_row_id)
    .bind(unrelated_field_id)
    .bind(other_row_id)
    .bind(other_field_id)
    .bind(other_database_id)
    .execute(&pool)
    .await
    .expect("seed canonical Tag cells");

    let unrelated_doc_before = document_search_tuple(&pool, workspace_id, unrelated_doc_id).await;
    let tagged_row_before_assignment = row_search_tuple(&pool, workspace_id, tagged_row_id).await;
    let unrelated_row_before = row_search_tuple(&pool, workspace_id, unrelated_row_id).await;
    let other_row_before = row_search_tuple(&pool, other_workspace_id, other_row_id).await;
    let assignment = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace_id,"docId":tagged_doc_id,"tagIds":[tag_id]}}
      }),
    )
    .await;
    assert_eq!(data(&assignment, &["setDocumentWorkspaceTags"]), &json!([tag_id]));
    let tagged_doc_assigned = document_search_tuple(&pool, workspace_id, tagged_doc_id).await;
    assert_eq!(tagged_doc_assigned.1[0]["name"], "Scoped old");
    assert_eq!(
      document_search_tuple(&pool, workspace_id, unrelated_doc_id).await,
      unrelated_doc_before,
      "assignment must not rewrite an unrelated document tuple"
    );
    assert_eq!(
      row_search_tuple(&pool, workspace_id, tagged_row_id).await,
      tagged_row_before_assignment,
      "document assignment must not rewrite even a Tag-referencing Database row"
    );
    assert_eq!(
      row_search_tuple(&pool, workspace_id, unrelated_row_id).await,
      unrelated_row_before
    );
    assert_eq!(
      row_search_tuple(&pool, other_workspace_id, other_row_id).await,
      other_row_before
    );

    let removal = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace_id,"docId":tagged_doc_id,"tagIds":[]}}
      }),
    )
    .await;
    assert_eq!(data(&removal, &["setDocumentWorkspaceTags"]), &json!([]));
    let tagged_doc_removed = document_search_tuple(&pool, workspace_id, tagged_doc_id).await;
    assert_ne!(
      tagged_doc_removed.0, tagged_doc_assigned.0,
      "removal must write the target tuple"
    );
    assert_eq!(tagged_doc_removed.1, json!([]));

    let reassignment = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace_id,"docId":tagged_doc_id,"tagIds":[tag_id]}}
      }),
    )
    .await;
    data(&reassignment, &["setDocumentWorkspaceTags"]);
    let before_description_doc = document_search_tuple(&pool, workspace_id, tagged_doc_id).await;
    let before_description_row = row_search_tuple(&pool, workspace_id, tagged_row_id).await;
    let description = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:UpdateWorkspaceTagDescriptionInput!){updateWorkspaceTagDescription(input:$input){description}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id,"description":"Not searchable"}}
      }),
    )
    .await;
    assert_eq!(
      data(&description, &["updateWorkspaceTagDescription", "description"]),
      "Not searchable"
    );
    assert_eq!(
      document_search_tuple(&pool, workspace_id, tagged_doc_id).await,
      before_description_doc,
      "description must not write document search"
    );
    assert_eq!(
      row_search_tuple(&pool, workspace_id, tagged_row_id).await,
      before_description_row,
      "description must not write Database-row search"
    );

    let rename = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:RenameWorkspaceTagInput!){renameWorkspaceTag(input:$input){name slug}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id,"name":"Scoped new"}}
      }),
    )
    .await;
    assert_eq!(data(&rename, &["renameWorkspaceTag", "slug"]), "scoped-new");
    let renamed_doc = document_search_tuple(&pool, workspace_id, tagged_doc_id).await;
    let renamed_row = row_search_tuple(&pool, workspace_id, tagged_row_id).await;
    assert_eq!(renamed_doc.1[0]["name"], "Scoped new");
    assert_eq!(renamed_row.1[0]["name"], "Scoped new");
    assert_ne!(renamed_doc.0, before_description_doc.0);
    assert_ne!(renamed_row.0, before_description_row.0);
    assert_eq!(
      document_search_tuple(&pool, workspace_id, unrelated_doc_id).await,
      unrelated_doc_before
    );
    assert_eq!(
      row_search_tuple(&pool, workspace_id, unrelated_row_id).await,
      unrelated_row_before
    );
    assert_eq!(
      row_search_tuple(&pool, other_workspace_id, other_row_id).await,
      other_row_before
    );

    let recolor = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:RecolorWorkspaceTagInput!){recolorWorkspaceTag(input:$input){colorRole}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id,"colorRole":"tag.green"}}
      }),
    )
    .await;
    assert_eq!(data(&recolor, &["recolorWorkspaceTag", "colorRole"]), "tag.green");
    assert_eq!(
      document_search_tuple(&pool, workspace_id, tagged_doc_id).await.1[0]["colorRole"],
      "tag.green"
    );
    assert_eq!(
      row_search_tuple(&pool, workspace_id, tagged_row_id).await.1[0]["colorRole"],
      "tag.green"
    );

    let archive = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:WorkspaceTagLifecycleInput!){archiveWorkspaceTag(input:$input){archived}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id}}
      }),
    )
    .await;
    assert_eq!(data(&archive, &["archiveWorkspaceTag", "archived"]), true);
    let archived_doc = document_search_tuple(&pool, workspace_id, tagged_doc_id).await;
    let archived_row = row_search_tuple(&pool, workspace_id, tagged_row_id).await;
    assert_eq!(archived_doc.1[0]["id"], tag_id);
    assert_eq!(archived_row.1[0]["id"], tag_id);
    let restore = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:WorkspaceTagLifecycleInput!){restoreWorkspaceTag(input:$input){archived}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id}}
      }),
    )
    .await;
    assert_eq!(data(&restore, &["restoreWorkspaceTag", "archived"]), false);

    let archive_for_delete = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:WorkspaceTagLifecycleInput!){archiveWorkspaceTag(input:$input){archived}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id}}
      }),
    )
    .await;
    data(&archive_for_delete, &["archiveWorkspaceTag"]);
    let deleted = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:WorkspaceTagLifecycleInput!){deleteWorkspaceTagPermanently(input:$input)}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":tag_id}}
      }),
    )
    .await;
    assert_eq!(data(&deleted, &["deleteWorkspaceTagPermanently"]), true);
    assert_eq!(
      document_search_tuple(&pool, workspace_id, tagged_doc_id).await.1,
      json!([])
    );
    assert_eq!(row_search_tuple(&pool, workspace_id, tagged_row_id).await.1, json!([]));
    assert_eq!(
      document_search_tuple(&pool, workspace_id, unrelated_doc_id).await,
      unrelated_doc_before
    );
    assert_eq!(
      row_search_tuple(&pool, workspace_id, unrelated_row_id).await,
      unrelated_row_before
    );
    assert_eq!(
      row_search_tuple(&pool, other_workspace_id, other_row_id).await,
      other_row_before
    );

    let failing_tag = create_tag(
      &app,
      owner_session,
      workspace_id,
      "Committed before refresh",
      "tag.red",
      None,
    )
    .await;
    let failing_tag_id = data(&failing_tag, &["createWorkspaceTag", "id"])
      .as_str()
      .expect("failing Tag id")
      .to_owned();
    sqlx::query("UPDATE search_content SET workspace_tags = '{}' WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(unrelated_doc_id)
      .execute(&pool)
      .await
      .expect("seed malformed derived payload");
    let rename_with_failed_refresh = helpers::gql(
      &app,
      owner_session,
      json!({
        "query":"mutation($input:RenameWorkspaceTagInput!){renameWorkspaceTag(input:$input){name}}",
        "variables":{"input":{"workspaceId":workspace_id,"tagId":failing_tag_id,"name":"Committed despite refresh"}}
      }),
    )
    .await;
    assert_eq!(
      data(&rename_with_failed_refresh, &["renameWorkspaceTag", "name"]),
      "Committed despite refresh",
      "derived refresh failure must not undo the authoritative catalog commit"
    );
    let committed_name: String = sqlx::query_scalar("SELECT name FROM workspace_tags WHERE id = $1")
      .bind(Uuid::parse_str(&failing_tag_id).unwrap())
      .fetch_one(&pool)
      .await
      .expect("read committed Tag after refresh failure");
    assert_eq!(committed_name, "Committed despite refresh");

    helpers::cleanup_workspaces(&pool, &[workspace_id, other_workspace_id]).await;
    helpers::cleanup_users(&pool, &[owner_id]).await;
  });
}

#[tokio::test]
async fn workspace_tag_repository_enforces_active_slug_scope_archive_readability_and_assignment_order() {
  let pool = helpers::setup_pool().await;
  let auth_store = std::sync::Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let (owner_id, _) = helpers::seed_admin(&pool, &auth_store).await;
  let first_workspace = helpers::create_workspace(&pool, owner_id).await;
  let second_workspace = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, first_workspace, owner_id).await;
  let repo = PgWorkspaceTagRepository::new(pool.clone(), crate::helpers::database_starter_catalog());

  let tag = |id, workspace_id, name: &str, slug: &str| WorkspaceTag {
    id,
    workspace_id,
    name: name.to_string(),
    slug: slug.to_string(),
    color_role: WorkspaceTagColorRole::Blue,
    description: None,
    archived_at: None,
    created_at: Utc::now(),
    updated_at: Utc::now(),
    created_by: Some(owner_id),
    updated_by: Some(owner_id),
  };

  let first_id = Uuid::new_v4();
  repo
    .create_tag(&tag(first_id, first_workspace, "Priority", "priority"))
    .await
    .expect("first workspace tag");
  let duplicate = repo
    .create_tag(&tag(Uuid::new_v4(), first_workspace, "Priority 2", "priority"))
    .await
    .expect_err("active slug must be unique inside one workspace");
  assert!(matches!(duplicate, RepositoryError::Conflict(_)));

  repo
    .create_tag(&tag(Uuid::new_v4(), second_workspace, "Priority", "priority"))
    .await
    .expect("same slug is valid in another workspace");
  repo
    .archive_tag(first_workspace, first_id, owner_id, Utc::now())
    .await
    .expect("archive first tag");
  let replacement_id = Uuid::new_v4();
  repo
    .create_tag(&tag(
      replacement_id,
      first_workspace,
      "Priority replacement",
      "priority",
    ))
    .await
    .expect("archived slug no longer occupies active uniqueness");

  let active = repo.list_tags(first_workspace, false).await.expect("active tags");
  assert_eq!(
    active.iter().map(|tag| tag.id).collect::<Vec<_>>(),
    vec![replacement_id]
  );
  let all = repo.list_tags(first_workspace, true).await.expect("all tags");
  assert_eq!(all.len(), 2);
  assert!(all.iter().any(|tag| tag.id == first_id && tag.archived_at.is_some()));

  let third_id = Uuid::new_v4();
  repo
    .create_tag(&tag(third_id, first_workspace, "Later", "later"))
    .await
    .expect("third tag");
  repo
    .replace_document_tag_ids(first_workspace, doc_id, &[third_id, replacement_id], owner_id)
    .await
    .expect("ordered assignment replacement");
  assert_eq!(
    repo
      .list_document_tag_ids(first_workspace, doc_id)
      .await
      .expect("ordered assignments"),
    vec![third_id, replacement_id]
  );

  let database_repo = PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
  let now = Utc::now();
  let database = Database {
    system_role: None,
    managed_installation: None,
    id: Uuid::new_v4(),
    workspace_id: first_workspace,
    profile_kind: myoxus_domain::database::DatabaseProfileKind::Generic,
    profile_structure_preset: None,
    profile_config: json!({}),
    title: "Atomic import target".to_string(),
    description: None,
    created_by: Some(owner_id),
    updated_by: Some(owner_id),
    deleted_at: None,
    deleted_by: None,
    edit_revision: 1,
    created_at: now,
    updated_at: now,
  };
  database_repo
    .create_database(myoxus_domain::database::DatabaseInitialState {
      database: database.clone(),
      fields: Vec::new(),
      views: Vec::new(),
      roles: Vec::new(),
      view_roles: Vec::new(),
      rows: Vec::new(),
      row_templates: Vec::new(),
      workspace_tags: Vec::new(),
    })
    .await
    .expect("seed conflicting Database id");
  let rolled_back_tag_id = Uuid::new_v4();
  let rolled_back_tag = tag(
    rolled_back_tag_id,
    first_workspace,
    "Rolled back import tag",
    "rolled-back-import-tag",
  );
  database_repo
    .apply_database_snapshot_import(
      DatabaseJsonImportMode::Create,
      None,
      None,
      database,
      Vec::new(),
      Vec::new(),
      Vec::new(),
      Vec::new(),
      Vec::new(),
      Vec::new(),
      Vec::new(),
      Vec::new(),
      vec![rolled_back_tag],
      None,
      None,
    )
    .await
    .expect_err("duplicate Database id must abort the complete import transaction");
  let rolled_back_tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_tags WHERE id = $1")
    .bind(rolled_back_tag_id)
    .fetch_one(&pool)
    .await
    .expect("rolled-back tag query");
  assert_eq!(
    rolled_back_tag_count, 0,
    "workspace tag creation must roll back with a failed Database import"
  );

  helpers::cleanup_workspaces(&pool, &[first_workspace, second_workspace]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

async fn wait_for_label_lock_waiters(pool: &sqlx::PgPool, application_name: &str, count: i64) {
  tokio::time::timeout(std::time::Duration::from_secs(10), async {
    loop {
      let waiting: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      )
      .bind(application_name)
      .fetch_one(pool)
      .await
      .expect("inspect our blocked writers");
      if waiting == count {
        break;
      }
      tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
  })
  .await
  .expect("label writers must reach the held database lock");
}

#[test]
fn workspace_tags_batched_reads_and_replacements_preserve_identity_acl_order_and_atomicity() {
  use futures_util::FutureExt;
  use myoxus_domain::workspace_tags::WorkspaceTagAssignmentError;
  helpers::block_on_large_stack("workspace-tags-batch-and-atomicity", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner, owner_session) = helpers::seed_user(&pool, &auth_store, "label-owner").await;
    let (reader, reader_session) = helpers::seed_user(&pool, &auth_store, "label-reader").await;
    let (external, external_session) = helpers::seed_user(&pool, &auth_store, "label-external").await;
    let (outsider, outsider_session) = helpers::seed_user(&pool, &auth_store, "label-outsider").await;
    let workspace = helpers::create_workspace(&pool, owner).await;
    let other_workspace = helpers::create_workspace(&pool, owner).await;
    let writer_name = format!("label-writers-{}", Uuid::new_v4());
    let writer_pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(2)
      .connect_with(pool.connect_options().as_ref().clone().application_name(&writer_name))
      .await
      .unwrap();
    let mut writers = tokio::task::JoinSet::new();
    let outcome = std::panic::AssertUnwindSafe(async {
      for (user, role) in [(reader, "Reader"), (external, "External")] {
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,$3,'Accepted',now())")
          .bind(workspace).bind(user).bind(role).execute(&pool).await.unwrap();
      }
      let mut docs = [helpers::create_doc(&pool, workspace, owner).await, helpers::create_doc(&pool, workspace, owner).await];
      docs.sort_unstable();
      let hidden_doc = docs[0];
      let visible_doc = docs[1];
      let visible_key = format!("label-visible-{visible_doc}");
      let hidden_key = visible_doc.to_string();
      for (doc, key) in [(visible_doc, &visible_key), (hidden_doc, &hidden_key)] {
        sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1").bind(doc).bind(key).execute(&pool).await.unwrap();
      }
      sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')")
        .bind(external).bind(visible_doc).execute(&pool).await.unwrap();
      let mut ids = Vec::new();
      for index in 0..4 {
        let response = create_tag(&app, owner_session, workspace, &format!("Label {index}"), "tag.blue", None).await;
        ids.push(Uuid::parse_str(data(&response, &["createWorkspaceTag", "id"]).as_str().unwrap()).unwrap());
      }
      let foreign = create_tag(&app, owner_session, other_workspace, "Foreign", "tag.green", None).await;
      let foreign_id = data(&foreign, &["createWorkspaceTag", "id"]).as_str().unwrap();
      let replace = |key: &str, ids: Value| json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace,"docId":key,"tagIds":ids}}
      });
      let initial = helpers::gql(&app, owner_session, replace(&visible_key, json!([ids[1],ids[0]]))).await;
      assert_eq!(data(&initial, &["setDocumentWorkspaceTags"]), &json!([ids[1],ids[0]]));
      let batch = |keys: Value| json!({
        "query":"query($workspace:String!,$keys:[ID!]!){workspace(id:$workspace){documentWorkspaceTagAssignments(externalIds:$keys){externalId tagIds}}}",
        "variables":{"workspace":workspace,"keys":keys}
      });
      let copy = |source: &str| json!({
        "query":"mutation($input:SetDocumentWorkspaceTagsInput!){setDocumentWorkspaceTags(input:$input)}",
        "variables":{"input":{"workspaceId":workspace,"docId":hidden_key,"copyFromDocId":source,"tagIds":[ids[1],ids[0]]}}
      });
      for session in [reader_session, external_session, outsider_session] {
        assert!(helpers::gql(&app, session, copy(&visible_key)).await.get("errors").is_some());
      }
      assert!(helpers::gql(&app, owner_session, copy(&visible_doc.to_string())).await.get("errors").is_some(), "UUID-shaped source keys must not fall back to internal IDs");
      let copied = helpers::gql(&app, owner_session, copy(&visible_key)).await;
      assert_eq!(data(&copied, &["setDocumentWorkspaceTags"]), &json!([ids[1],ids[0]]));
      let cleared = helpers::gql(&app, owner_session, replace(&hidden_key,json!([]))).await;
      assert_eq!(data(&cleared, &["setDocumentWorkspaceTags"]), &json!([]));
      let keys = json!([visible_key, hidden_key, "missing-key"]);
      for session in [owner_session, reader_session] {
        let response = helpers::gql(&app, session, batch(keys.clone())).await;
        assert_eq!(data(&response, &["workspace","documentWorkspaceTagAssignments"]), &json!([
          {"externalId":visible_key,"tagIds":[ids[1],ids[0]]},
          {"externalId":hidden_key,"tagIds":[]},
          {"externalId":"missing-key","tagIds":null}
        ]), "UUID-shaped keys must resolve external identity, never the surrogate id");
      }
      let response = helpers::gql(&app, external_session, batch(keys.clone())).await;
      assert_eq!(data(&response, &["workspace","documentWorkspaceTagAssignments"]), &json!([
        {"externalId":visible_key,"tagIds":[ids[1],ids[0]]},
        {"externalId":hidden_key,"tagIds":null},
        {"externalId":"missing-key","tagIds":null}
      ]));
      assert!(helpers::gql(&app, outsider_session, batch(keys)).await.get("errors").is_some());
      assert!(helpers::gql(&app, owner_session, batch(json!(vec![visible_key.clone();201]))).await.get("errors").is_some());
      let denied = helpers::gql(&app, reader_session, replace(&visible_key, json!([]))).await;
      assert_eq!(error_code(&denied), "MIX_WORKSPACE_TAG_FORBIDDEN");
      let foreign = helpers::gql(&app, owner_session, replace(&visible_key, json!([ids[2],foreign_id]))).await;
      assert_eq!(error_code(&foreign), "MIX_WORKSPACE_TAG_CROSS_WORKSPACE");
      let repo = PgWorkspaceTagRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
      assert_eq!(repo.list_document_tag_ids(workspace, visible_doc).await.unwrap(), vec![ids[1],ids[0]], "invalid replacement is atomic");
      let archived_at = chrono::DateTime::parse_from_rfc3339("2024-01-02T03:04:05Z").unwrap().with_timezone(&Utc);
      repo.update_tag_description(workspace, ids[3], Some("Portable archived description"), owner, Utc::now()).await.unwrap();
      repo.archive_tag(workspace, ids[3], owner, archived_at).await.unwrap();
      let export = |keys: Value| json!({
        "query":"query($workspace:String!,$keys:[ID!]!){workspace(id:$workspace){exportWorkspaceTags(externalIds:$keys)}}",
        "variables":{"workspace":workspace,"keys":keys}
      });
      for session in [owner_session, reader_session, external_session] {
        let response = helpers::gql(&app, session, export(json!([visible_key]))).await;
        let portable = data(&response, &["workspace", "exportWorkspaceTags"]);
        assert_eq!(portable["documents"], json!([{"sourceId":visible_key,"externalId":visible_key,"tags":[ids[1],ids[0]]}]));
        assert_eq!(portable["workspaceTags"].as_array().unwrap().len(), 4);
        assert!(portable["workspaceTags"].as_array().unwrap().iter().all(|tag| tag["colorRole"] == "tag.blue"));
        let archived = portable["workspaceTags"].as_array().unwrap().iter().find(|tag| tag["id"] == ids[3].to_string()).unwrap();
        assert_eq!(archived["description"], "Portable archived description");
        assert_eq!(archived["archived"], true);
        assert_eq!(archived["archivedAt"], archived_at.to_rfc3339());
      }
      for (session, keys) in [(external_session, json!([hidden_key])), (outsider_session,json!([visible_key])),
          (owner_session,json!(["missing"])), (owner_session,json!([visible_key,visible_key]))] {
        assert!(helpers::gql(&app, session, export(keys)).await.get("errors").is_some(), "unavailable export must fail, not erase labels");
      }
      let export_key = myoxus_domain::document_key::DocumentKey::parse(&visible_key).unwrap();
      assert!(repo.export_tags(workspace, &[export_key], 1).await.is_err(), "metadata bound must reject output");
      repo.restore_tag(workspace, ids[3], "label-3", owner, Utc::now()).await.unwrap();
      let hidden = helpers::gql(&app, owner_session, replace(&hidden_key, json!([ids[0]]))).await;
      data(&hidden, &["setDocumentWorkspaceTags"]);
      let usages = |offset| json!({
        "query":"query($workspace:String!,$tag:ID!,$offset:Int){workspace(id:$workspace){workspaceTagDocumentUsages(tagId:$tag,first:1,offset:$offset){items{externalId}nextOffset}}}",
        "variables":{"workspace":workspace,"tag":ids[0],"offset":offset}
      });
      let first = helpers::gql(&app, external_session, usages(0)).await;
      assert_eq!(data(&first, &["workspace","workspaceTagDocumentUsages"]), &json!({"items":[],"nextOffset":1}), "a denied candidate must not terminate traversal");
      let second = helpers::gql(&app, external_session, usages(1)).await;
      assert_eq!(data(&second, &["workspace","workspaceTagDocumentUsages"]), &json!({"items":[{"externalId":visible_key}],"nextOffset":null}));

      repo.replace_document_tag_ids(workspace, visible_doc, &[], owner).await.unwrap();
      let mut blocker = pool.begin().await.unwrap();
      sqlx::query("SELECT id FROM docs WHERE id=$1 FOR UPDATE").bind(visible_doc).execute(&mut *blocker).await.unwrap();
      for tags in [vec![ids[1],ids[0]],vec![ids[3],ids[2]]] {
        let repo = PgWorkspaceTagRepository::new(writer_pool.clone(), crate::helpers::database_starter_catalog());
        writers.spawn(async move { repo.replace_document_tag_ids(workspace, visible_doc, &tags, owner).await });
      }
      // Both writers must reach a real database lock before either can publish.
      // Without document serialization both delete an empty set, then collide or mix.
      wait_for_label_lock_waiters(&pool, &writer_name, 2).await;
      blocker.commit().await.unwrap();
      for _ in 0..2 {
        tokio::time::timeout(std::time::Duration::from_secs(10), writers.join_next()).await.unwrap().unwrap().unwrap().expect("both serialized replacements succeed");
      }
      let actual = repo.list_document_tag_ids(workspace, visible_doc).await.unwrap();
      assert!(actual == vec![ids[1],ids[0]] || actual == vec![ids[3],ids[2]], "concurrent replacements must not publish a mixed assignment");

      repo.replace_document_tag_ids(workspace, visible_doc, &[], owner).await.unwrap();
      let mut archive = pool.begin().await.unwrap();
      sqlx::query("UPDATE workspace_tags SET archived_at=now() WHERE id=$1").bind(ids[0]).execute(&mut *archive).await.unwrap();
      let writing_repo = PgWorkspaceTagRepository::new(writer_pool.clone(), crate::helpers::database_starter_catalog());
      let archived_id = ids[0];
      writers.spawn(async move { writing_repo.replace_document_tag_ids(workspace, visible_doc, &[archived_id], owner).await });
      wait_for_label_lock_waiters(&pool, &writer_name, 1).await;
      archive.commit().await.unwrap();
      let result = tokio::time::timeout(std::time::Duration::from_secs(10), writers.join_next()).await.unwrap().unwrap().unwrap();
      assert!(matches!(result, Err(WorkspaceTagAssignmentError::ArchivedReference)), "archive completing during validation must reject a new reference");
      assert!(repo.list_document_tag_ids(workspace, visible_doc).await.unwrap().is_empty());
    }).catch_unwind().await;
    writers.shutdown().await;
    writer_pool.close().await;
    helpers::cleanup_workspaces(&pool, &[workspace, other_workspace]).await;
    helpers::cleanup_users(&pool, &[owner, reader, external, outsider]).await;
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE id=ANY($1)")
      .bind(vec![workspace, other_workspace])
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(remaining, 0, "label fixtures must be removed");
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}
