//! P6 contextual template suggestion GraphQL contract tests.
//!
//! These tests exercise the public workspace resolver instead of only the
//! application service. They would fail if the resolver leaked disabled or
//! unpublished templates, lost structured error codes, or bypassed workspace
//! ACL before ranking suggestions.

use crate::helpers;

use chrono::Utc;
use myoxus_application::template_registry::TemplateRegistryStore as _;
use myoxus_domain::template_registry::{
  InstanceState, ProvisioningMode, RevisionState, SelectionMode, TemplateCatalogEntry, TemplateRevision,
  TemplateStatus, WorkspaceTemplateInstance, WorkspaceTemplatePolicy,
};
use myoxus_infrastructure::template_registry::SqlxTemplateRegistryStore;
use serde_json::{Value, json};
use uuid::Uuid;

const TEMPLATE_SUGGESTIONS_QUERY: &str = r#"
  query TemplateSuggestions($workspaceId: String!, $input: TemplateSuggestionInput!) {
    workspace(id: $workspaceId) {
      templateSuggestions(input: $input) {
        items {
          templateId
          templateDocId
           slug
           title
           source
           sourceRevisionId
           category
           tags
          score
          available
          reasons
          instanceState
        }
        pageDefaultReplacements {
          retiredSourceDocId
          replacementSourceDocId
        }
        emptyDocumentAllowed
        reconcileRequired
        stale
        hasNextPage
        endCursor
      }
    }
  }
"#;

#[tokio::test]
async fn inv_template_suggestions_graphql_filters_candidates_and_maps_states() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_template_registry_service().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "template-suggestions-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let slug_prefix = format!("p6-{}", Uuid::new_v4());
  let usable_slug = format!("{slug_prefix}-usable");
  let disabled_slug = format!("{slug_prefix}-policy-disabled");
  let unpublished_slug = format!("{slug_prefix}-unpublished");
  let archived_slug = format!("{slug_prefix}-archived");
  let hidden_slug = format!("{slug_prefix}-hidden");

  let usable_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let usable = seed_template(
    &store,
    TemplateSeed {
      workspace_id,
      slug: &usable_slug,
      title: "P6 Usable",
      status: TemplateStatus::Active,
      revision_state: RevisionState::Published,
      policy_enabled: true,
      instance_doc_id: Some(usable_doc_id),
    },
  )
  .await;
  let usable_doc_key = format!("template-visible-{slug_prefix}");
  sqlx::query("UPDATE docs SET external_id = $1 WHERE id = $2 AND workspace_id = $3")
    .bind(&usable_doc_key)
    .bind(usable_doc_id)
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("set client-visible template document key");
  sqlx::query(
    "UPDATE workspace_template_instances SET workspace_doc_key = $1 WHERE template_id = $2 AND workspace_id = $3",
  )
  .bind(&usable_doc_key)
  .bind(usable)
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("persist client-visible template document key");
  seed_template(
    &store,
    TemplateSeed {
      workspace_id,
      slug: &disabled_slug,
      title: "P6 Policy Disabled",
      status: TemplateStatus::Active,
      revision_state: RevisionState::Published,
      policy_enabled: false,
      instance_doc_id: Some(helpers::create_doc(&pool, workspace_id, owner_id).await),
    },
  )
  .await;
  seed_template(
    &store,
    TemplateSeed {
      workspace_id,
      slug: &unpublished_slug,
      title: "P6 Unpublished",
      status: TemplateStatus::Active,
      revision_state: RevisionState::Draft,
      policy_enabled: true,
      instance_doc_id: Some(helpers::create_doc(&pool, workspace_id, owner_id).await),
    },
  )
  .await;
  seed_template(
    &store,
    TemplateSeed {
      workspace_id,
      slug: &archived_slug,
      title: "P6 Archived",
      status: TemplateStatus::Archived,
      revision_state: RevisionState::Published,
      policy_enabled: true,
      instance_doc_id: Some(helpers::create_doc(&pool, workspace_id, owner_id).await),
    },
  )
  .await;
  let hidden_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  seed_template(
    &store,
    TemplateSeed {
      workspace_id,
      slug: &hidden_slug,
      title: "P6 Z Hidden",
      status: TemplateStatus::Active,
      revision_state: RevisionState::Published,
      policy_enabled: true,
      instance_doc_id: Some(hidden_doc_id),
    },
  )
  .await;
  sqlx::query(
    "INSERT INTO template_registry_audit_events (action, event_type, workspace_id, payload_json) VALUES ('updated', 'template.default.replaced', $1, $2), ('updated', 'template.default.replaced', $1, $3)",
  )
  .bind(workspace_id)
  .bind(json!({
    "retired_source_doc_id": "retired-visible-source",
    "replacement_source_doc_id": usable_doc_key,
  }))
  .bind(json!({
    "retired_source_doc_id": "retired-hidden-source",
    "replacement_source_doc_id": null,
  }))
  .execute(&pool)
  .await
  .expect("seed confirmed page-default replacements");

  let first_page = helpers::gql(
    &app,
    owner_session,
    suggestion_payload(
      workspace_id,
      json!({
        "surface": "AllPagesNewPage",
        "locale": "en",
        "clientVersion": 1,
        "first": 1
      }),
    ),
  )
  .await;

  assert_no_errors(&first_page);
  let first_result = &first_page["data"]["workspace"]["templateSuggestions"];
  let items = first_result["items"].as_array().expect("suggestion items");
  assert_eq!(
    items
      .iter()
      .map(|item| item["slug"].as_str().unwrap())
      .collect::<Vec<_>>(),
    vec![usable_slug.as_str()],
    "disabled, archived and unpublished templates must not leak through GraphQL"
  );
  let item = &items[0];
  assert_eq!(item["templateId"].as_str(), Some(usable.to_string().as_str()));
  assert_eq!(item["templateDocId"].as_str(), Some(usable_doc_key.as_str()));
  assert_eq!(item["available"].as_bool(), Some(true));
  assert!(
    item["reasons"]
      .as_array()
      .unwrap()
      .iter()
      .any(|reason| reason == "WorkspacePolicy")
  );
  assert!(
    item["reasons"]
      .as_array()
      .unwrap()
      .iter()
      .any(|reason| reason == "InstanceOk")
  );
  assert_eq!(first_result["emptyDocumentAllowed"].as_bool(), Some(true));
  let replacements = first_result["pageDefaultReplacements"].as_array().unwrap();
  assert_eq!(replacements.len(), 2);
  assert!(
    replacements.contains(&json!({
      "retiredSourceDocId":"retired-visible-source", "replacementSourceDocId":usable_doc_key,
    })),
    "an explicit durable replacement retains its document key"
  );
  assert!(
    replacements.contains(&json!({
      "retiredSourceDocId":"retired-hidden-source", "replacementSourceDocId":null,
    })),
    "withdrawal clears only the retired preference without choosing another source"
  );
  assert_eq!(first_result["hasNextPage"].as_bool(), Some(true));
  let end_cursor = first_result["endCursor"].as_str().expect("first-page cursor");

  let second_page = helpers::gql(
    &app,
    owner_session,
    suggestion_payload(
      workspace_id,
      json!({
        "surface": "AllPagesNewPage",
        "locale": "en",
        "clientVersion": 1,
        "first": 1,
        "after": end_cursor
      }),
    ),
  )
  .await;
  assert_no_errors(&second_page);
  let second_result = &second_page["data"]["workspace"]["templateSuggestions"];
  assert_eq!(second_result["items"][0]["slug"].as_str(), Some(hidden_slug.as_str()));
  assert_eq!(second_result["hasNextPage"].as_bool(), Some(false));

  let (external_id, external_session) = helpers::seed_user(&pool, &auth_store, "template-suggestions-external").await;
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'External', 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(external_id)
  .execute(&pool)
  .await
  .expect("grant workspace discovery access");
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Reader')")
    .bind(external_id)
    .bind(usable_doc_id)
    .execute(&pool)
    .await
    .expect("grant visible source access");

  let filtered = helpers::gql(
    &app,
    external_session,
    suggestion_payload(
      workspace_id,
      json!({
        "surface": "AllPagesNewPage",
        "locale": "en",
        "clientVersion": 1,
        "first": 10
      }),
    ),
  )
  .await;
  assert!(
    filtered.get("errors").is_some(),
    "External cannot enter the template catalog: {filtered}"
  );
  assert!(!filtered.to_string().contains(&usable_slug));

  sqlx::query("INSERT INTO document_template_state(doc_id,state,source,updated_by) VALUES($1,'managed','document',$2)")
    .bind(usable_doc_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .unwrap();
  let preview = helpers::gql(
    &app,
    external_session,
    json!({
      "query":"query($w:String!,$d:String!){workspace(id:$w){doc(docId:$d){id}}}",
      "variables":{"w":workspace_id.to_string(),"d":usable_doc_key}
    }),
  )
  .await;
  assert!(
    preview.get("errors").is_some(),
    "External source preview ignores its document grant: {preview}"
  );

  // Catalog exclusion must not become a global External workspace/doc denial.
  let ordinary = helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')")
    .bind(external_id)
    .bind(ordinary)
    .execute(&pool)
    .await
    .unwrap();
  let ordinary_read = helpers::gql(
    &app,
    external_session,
    json!({
      "query":"query($w:String!,$d:String!){workspace(id:$w){id doc(docId:$d){id}}}",
      "variables":{"w":workspace_id.to_string(),"d":ordinary.to_string()}
    }),
  )
  .await;
  assert_no_errors(&ordinary_read);
  assert_eq!(ordinary_read["data"]["workspace"]["doc"]["id"], ordinary.to_string());

  sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
    .bind(workspace_id)
    .bind(external_id)
    .execute(&pool)
    .await
    .unwrap();
  let reader = helpers::gql(
    &app,
    external_session,
    suggestion_payload(
      workspace_id,
      json!({
        "surface":"AllPagesNewPage","locale":"en","clientVersion":1,"first":10
      }),
    ),
  )
  .await;
  assert_no_errors(&reader);
  assert_eq!(
    reader["data"]["workspace"]["templateSuggestions"]["items"]
      .as_array()
      .unwrap()
      .len(),
    2
  );
  assert!(
    reader.to_string().contains(&hidden_slug),
    "internal Reader sees sources without grants"
  );
  helpers::cleanup_users(&pool, &[owner_id, external_id]).await;
  sqlx::query("DELETE FROM template_catalog_entries WHERE slug LIKE $1")
    .bind(format!("{slug_prefix}%"))
    .execute(&pool)
    .await
    .expect("remove owned catalog fixtures");
}

#[tokio::test]
async fn inv_template_library_graphql_pages_native_sources_and_preserves_missing_assignments() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_template_registry_service().await;
  let (owner, session) = helpers::seed_user(&pool, &auth_store, "template-library-owner").await;
  let workspace = helpers::create_workspace(&pool, owner).await;
  let store = SqlxTemplateRegistryStore::new(pool.clone());
  let prefix = format!("library-{}", Uuid::new_v4());
  let missing = seed_template(
    &store,
    TemplateSeed {
      workspace_id: workspace,
      slug: &format!("{prefix}-missing"),
      title: "Missing assigned source",
      status: TemplateStatus::Active,
      revision_state: RevisionState::Published,
      policy_enabled: true,
      instance_doc_id: Some(helpers::create_doc(&pool, workspace, owner).await),
    },
  )
  .await;
  let preparing = seed_template(
    &store,
    TemplateSeed {
      workspace_id: workspace,
      slug: &format!("{prefix}-preparing"),
      title: "Preparing assigned source",
      status: TemplateStatus::Active,
      revision_state: RevisionState::Published,
      policy_enabled: true,
      instance_doc_id: None,
    },
  )
  .await;
  sqlx::query("UPDATE template_revisions SET manifest_json=$2 WHERE template_id=$1")
    .bind(missing)
    .bind(json!({"template_id":format!("{prefix}-missing"),"version":"1.0.0","title":"Goals","locale":"en",
      "localized_contents":{"de":{"title":"Ziele","description":"Zielkriterien","path":"localized/de.template.zip","sha256":"test-metadata-only"}}}))
    .execute(&pool).await.unwrap();
  sqlx::query("UPDATE workspace_template_instances SET locale_hash='de-DE' WHERE workspace_id=$1 AND template_id=$2")
    .bind(workspace)
    .bind(missing)
    .execute(&pool)
    .await
    .unwrap();
  // Metadata-only native fixtures deliberately have no snapshot/bundle: an
  // inventory must neither need nor hydrate their content to list them.
  sqlx::query(r#"
    WITH sources AS (
      INSERT INTO docs(workspace_id,external_id,title,created_by,updated_at)
      SELECT $1, 'native-' || n, 'Source ' || lpad(n::text,3,'0'), $2, '2026-01-01'::timestamptz
      FROM generate_series(0,204) n RETURNING id
    )
    INSERT INTO document_template_state(doc_id,state,source,metadata,updated_by,updated_at)
    SELECT id,'detached','document','{"origin":"custom","category":"building-blocks","tags":["operations"]}'::jsonb,$2,'2026-01-01'::timestamptz
    FROM sources
  "#).bind(workspace).bind(owner).execute(&pool).await.unwrap();

  for sort in ["NameAsc", "NameDesc", "UpdatedAsc", "UpdatedDesc"] {
    let first = helpers::gql(
      &app,
      session,
      suggestion_payload(
        workspace,
        json!({
          "surface":"Library","locale":"de","clientVersion":1,"first":200,"library":{"sort":sort}
        }),
      ),
    )
    .await;
    assert_no_errors(&first);
    let page = &first["data"]["workspace"]["templateSuggestions"];
    assert_eq!(page["items"].as_array().unwrap().len(), 200);
    assert_eq!(page["hasNextPage"], true);
    assert_eq!(page["pageDefaultReplacements"], json!([]));
    let second = helpers::gql(
      &app,
      session,
      suggestion_payload(
        workspace,
        json!({
          "surface":"Library","locale":"de","clientVersion":1,"first":200,
          "after":page["endCursor"],"library":{"sort":sort}
        }),
      ),
    )
    .await;
    assert_no_errors(&second);
    let last = &second["data"]["workspace"]["templateSuggestions"];
    assert_eq!(last["items"].as_array().unwrap().len(), 7);
    assert_eq!(last["hasNextPage"], false);
    let items = page["items"]
      .as_array()
      .unwrap()
      .iter()
      .chain(last["items"].as_array().unwrap());
    let by_id = items
      .map(|item| (item["templateId"].as_str().unwrap(), item))
      .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
      by_id.len(),
      207,
      "keyset pages must not repeat or lose tied rows ({sort})"
    );
    assert_eq!(by_id["native-204"]["source"], "custom");
    assert_eq!(by_id["native-204"]["templateDocId"], "native-204");
    assert!(by_id["native-204"]["sourceRevisionId"].is_null());
    assert_eq!(by_id[&missing.to_string()[..]]["available"], false);
    assert_eq!(
      by_id[&missing.to_string()[..]]["title"],
      "Ziele",
      "labels follow persisted content locale, including its base-language fallback"
    );
    assert!(
      by_id[&missing.to_string()[..]]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("SourceMissing"))
    );
    assert!(
      by_id[&preparing.to_string()[..]]["reasons"]
        .as_array()
        .unwrap()
        .contains(&json!("Preparing"))
    );
  }

  let filtered = helpers::gql(
    &app,
    session,
    suggestion_payload(
      workspace,
      json!({
        "surface":"Library","locale":"de","clientVersion":1,"first":1,
        "library":{"kind":"BuildingBlock","search":"Source 204","origin":"Custom","workAreaTag":"operations"}
      }),
    ),
  )
  .await;
  assert_no_errors(&filtered);
  assert_eq!(
    filtered["data"]["workspace"]["templateSuggestions"]["items"][0]["templateDocId"],
    "native-204"
  );
  assert_eq!(
    filtered["data"]["workspace"]["templateSuggestions"]["hasNextPage"],
    false
  );

  let ordinary = helpers::create_doc(&pool, workspace, owner).await;
  for (key, count) in [("native-204".to_string(), 1), (ordinary.to_string(), 0)] {
    let exact = helpers::gql(
      &app,
      session,
      suggestion_payload(
        workspace,
        json!({
          "surface":"Library","locale":"en","clientVersion":1,"library":{"sourceDocId":key}
        }),
      ),
    )
    .await;
    assert_no_errors(&exact);
    assert_eq!(
      exact["data"]["workspace"]["templateSuggestions"]["items"]
        .as_array()
        .unwrap()
        .len(),
      count
    );
    assert_eq!(exact["data"]["workspace"]["templateSuggestions"]["hasNextPage"], false);
  }
  sqlx::query("UPDATE document_template_state SET state='none' WHERE doc_id=(SELECT id FROM docs WHERE workspace_id=$1 AND external_id='native-204')")
    .bind(workspace).execute(&pool).await.unwrap();
  let withdrawn = helpers::gql(
    &app,
    session,
    suggestion_payload(
      workspace,
      json!({
        "surface":"Library","locale":"en","clientVersion":1,"library":{"sourceDocId":"native-204"}
      }),
    ),
  )
  .await;
  assert_no_errors(&withdrawn);
  assert_eq!(
    withdrawn["data"]["workspace"]["templateSuggestions"]["items"],
    json!([])
  );
  helpers::cleanup_users(&pool, &[owner]).await;
  sqlx::query("DELETE FROM template_catalog_entries WHERE slug LIKE $1")
    .bind(format!("{prefix}%"))
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn inv_template_suggestions_graphql_returns_stable_error_codes() {
  let _guard = helpers::TEMPLATE_REGISTRY_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  let (app, pool, auth_store) = helpers::setup_app_with_template_registry_service().await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "template-suggestions-errors-owner").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let invalid = helpers::gql(
    &app,
    owner_session,
    suggestion_payload(
      workspace_id,
      json!({
        "surface": "AllPagesNewPage",
        "locale": "",
        "clientVersion": 1
      }),
    ),
  )
  .await;
  assert_error_code(&invalid, "MIX_TEMPLATE_SUGGESTIONS_INPUT_INVALID");
}

struct TemplateSeed<'a> {
  workspace_id: Uuid,
  slug: &'a str,
  title: &'a str,
  status: TemplateStatus,
  revision_state: RevisionState,
  policy_enabled: bool,
  instance_doc_id: Option<Uuid>,
}

async fn seed_template(store: &SqlxTemplateRegistryStore, seed: TemplateSeed<'_>) -> Uuid {
  let template_id = Uuid::new_v4();
  let revision_id = Uuid::new_v4();
  let now = Utc::now();
  store
    .create_catalog_entry(&TemplateCatalogEntry {
      id: template_id,
      slug: seed.slug.to_string(),
      title: seed.title.to_string(),
      description: Some(format!("{} description", seed.title)),
      category: Some("project".to_string()),
      tags: Vec::new(),
      status: seed.status,
      source: myoxus_domain::template_registry::TemplateSource::Bundle,
      builder_version: None,
      min_client_version: 0,
      created_at: now,
      updated_at: now,
      archived_at: (seed.status == TemplateStatus::Archived).then_some(now),
    })
    .await
    .expect("create catalog entry");
  store
    .create_revision(&TemplateRevision {
      id: revision_id,
      template_id,
      version: "1.0.0".to_string(),
      state: seed.revision_state,
      bundle_blob_id: None,
      preview_blob_id: None,
      checksum: None,
      manifest: None,
      release_notes: None,
      created_by: None,
      created_at: now,
      published_at: (seed.revision_state == RevisionState::Published).then_some(now),
      source_format: "snapshot".to_string(),
      normalizer_version: "test".to_string(),
      detected_format: "snapshot".to_string(),
      ignored_entries_count: 0,
      error_catalog_version: "test".to_string(),
      normalization_warnings: Vec::new(),
    })
    .await
    .expect("create revision");
  store
    .create_policy(&WorkspaceTemplatePolicy {
      id: Uuid::new_v4(),
      workspace_id: seed.workspace_id,
      template_id,
      selection_mode: SelectionMode::Published,
      selected_revision_id: None,
      provisioning_mode: ProvisioningMode::SeedOnce,
      is_enabled: seed.policy_enabled,
      created_at: now,
      updated_at: now,
    })
    .await
    .expect("create policy");
  if let Some(doc_id) = seed.instance_doc_id {
    store
      .create_instance(&WorkspaceTemplateInstance {
        id: Uuid::new_v4(),
        workspace_id: seed.workspace_id,
        template_id,
        revision_id,
        workspace_doc_id: Some(doc_id),
        workspace_doc_key: Some(doc_id.to_string()),
        state: InstanceState::Ok,
        last_applied_hash: None,
        current_hash: None,
        last_synced_at: Some(now),
        detached_at: None,
        retired_at: None,
        last_error_code: None,
        last_error_message: None,
        expected_hash: None,
        locale_hash: None,
      })
      .await
      .expect("create instance");
  }
  template_id
}

fn suggestion_payload(workspace_id: Uuid, input: Value) -> Value {
  json!({
    "query": TEMPLATE_SUGGESTIONS_QUERY,
    "variables": {
      "workspaceId": workspace_id.to_string(),
      "input": input
    }
  })
}

fn assert_no_errors(response: &Value) {
  assert!(
    response.get("errors").is_none(),
    "GraphQL response must not contain errors: {response}"
  );
}

fn assert_error_code(response: &Value, expected_code: &str) {
  let code = response["errors"][0]["extensions"]["code"].as_str().unwrap_or_default();
  assert_eq!(code, expected_code, "unexpected GraphQL response: {response}");
}
