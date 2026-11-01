// SPDX-License-Identifier: AGPL-3.0-or-later
//! Exercise the public transport and original identity across the managed boundary.
use super::*;

const DESTINATIONS: &str = "query($w:String!){workspace(id:$w){databaseTaskDestinations(first:1){defaultDestination{databaseId editRevision managedSchema{readiness schemaRevision templateVersion canEditStructure canEditMetadata canManageLifecycle taskBindings{roleKey fieldId}}} projects{databaseId editRevision managedSchema{readiness schemaRevision}} coverageComplete unavailableProjects{databaseId reasonCode}} databases(first:100){id}}}";
const ROW: &str = "query($w:String!,$d:ID!,$r:ID!){workspace(id:$w){databaseRow(databaseId:$d,rowId:$r){row{id databaseId title editRevision rowKind} cellRevisions{fieldId editRevision}}}}";

fn assert_product_rejection(response: &Value) {
  let errors = gql_errors(response);
  assert_eq!(errors.len(), 1, "expected one product rejection: {response:#}");
  assert!(
    errors[0]["extensions"]["code"]
      .as_str()
      .is_some_and(|code| code.starts_with("MIX_DATABASE_")),
    "schema/transport errors do not prove a protected write: {response:#}"
  );
}

#[test]
fn managed_default_public_guards_and_capture_move_keep_original_identity() {
  helpers::block_on_large_stack("managed-default-public-contract", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner, session) = helpers::seed_user(&pool, &auth_store, "managed-default-public").await;
    let body = AssertUnwindSafe(async {
      // This must use the real creation resolver: a manually prepared fixture
      // cannot prove that a successfully published workspace has its default.
      let created = helpers::gql(&app, session, json!({"query":"mutation{auth{createWorkspace{id}}}"})).await;
      let workspace = gql_data(&created, &["auth","createWorkspace"])["id"].as_str().unwrap().to_string();
      let inventory = helpers::gql(&app, session, json!({"query":DESTINATIONS,"variables":{"w":workspace}})).await;
      let destinations = &gql_data(&inventory, &["workspace","databaseTaskDestinations"]);
      let default = destinations["defaultDestination"].clone();
      let default_id = default["databaseId"].as_str().expect("published default").to_string();
      assert_eq!(default["managedSchema"]["readiness"], "Ready");
      assert_eq!(default["managedSchema"]["templateVersion"], "1.0.1");
      for capability in ["canEditStructure","canEditMetadata","canManageLifecycle"] {
        assert_eq!(default["managedSchema"][capability], false);
      }
      assert_eq!(destinations["coverageComplete"], true);
      assert_eq!(gql_data(&inventory, &["workspace","databases"]), &json!([]));
      let identity = helpers::gql(&app, session, json!({
        "query":"query($w:String!,$d:ID!){workspace(id:$w){databaseSummary(databaseId:$d){id systemRole}}}",
        "variables":{"w":workspace,"d":default_id},
      })).await;
      assert_eq!(gql_data(&identity, &["workspace","databaseSummary"]), &json!({
        "id":default_id,"systemRole":"WorkspaceTasks",
      }));
      let initial_counts: (i64,i64) = sqlx::query_as("SELECT count(*),(SELECT count(*) FROM workspace_database_rows WHERE database_id=$2) FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(Uuid::parse_str(&workspace).unwrap()).bind(Uuid::parse_str(&default_id).unwrap()).fetch_one(&pool).await.unwrap();
      assert_eq!(initial_counts,(1,0));
      let binding = default["managedSchema"]["taskBindings"].as_array().unwrap().iter()
        .find(|binding| binding["roleKey"] == "task.title").expect("guaranteed native title")["fieldId"].clone();
      let field_revision: i64 = sqlx::query_scalar("SELECT edit_revision FROM workspace_database_fields WHERE id=$1")
        .bind(Uuid::parse_str(binding.as_str().unwrap()).unwrap()).fetch_one(&pool).await.unwrap();
      for (query,input) in [
        ("mutation($i:UpdateDatabaseInput!){updateDatabase(input:$i){database{id}}}",json!({"databaseId":default_id,"title":"Unprotected","force":true})),
        ("mutation($i:DatabaseLifecycleInput!){trashDatabase(input:$i){database{id}}}",json!({"databaseId":default_id,"force":true})),
        ("mutation($i:UpdateDatabaseFieldInput!){updateDatabaseField(input:$i){id}}",json!({"databaseId":default_id,"fieldId":binding,"name":"User schema","expectedEditRevision":field_revision,"force":true})),
      ] {
        let rejected = helpers::gql(&app,session,json!({"query":query,"variables":{"i":input}})).await;
        assert_product_rejection(&rejected);
      }

      let mut projects = Vec::new();
      for template in ["myoxus.project.simple_project","myoxus.project.product_roadmap","myoxus.project.bug_tracker"] {
        let created = helpers::gql(&app,session,json!({
          "query":"mutation($i:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$i){database{id editRevision} managedSchema{readiness schemaRevision canEditStructure canEditMetadata canManageLifecycle} fieldRoles{roleKey fieldId}}}",
          "variables":{"i":{"workspaceId":workspace,"templateId":template,"title":template,"includeSampleRows":false,"priorityPreset":"ThreeStep","complexityPreset":"ThreeStep","structurePreset":"TasksOnly"}}
        })).await;
        let project=gql_data(&created,&["createDatabaseFromTemplate"]).clone();
        assert_eq!(project["managedSchema"]["readiness"],"Ready");
        assert_eq!(project["managedSchema"]["canEditStructure"],false);
        assert_eq!(project["managedSchema"]["canEditMetadata"],true);
        assert_eq!(project["managedSchema"]["canManageLifecycle"],true);
        projects.push(project);
      }
      // The canonical default is independent of the paginated optional list.
      let paged=helpers::gql(&app,session,json!({"query":DESTINATIONS,"variables":{"w":workspace}})).await;
      let paged=gql_data(&paged,&["workspace","databaseTaskDestinations"]);
      assert_eq!(paged["defaultDestination"]["databaseId"],default_id);
      assert_eq!(paged["projects"].as_array().unwrap().len(),1);

      let source=Uuid::new_v4();
      sqlx::query("INSERT INTO docs(id,external_id,workspace_id,title,created_by,updated_by) VALUES($1,$2,$3,'Capture original',$4,$4)")
        .bind(source).bind(format!("origin-{source}")).bind(Uuid::parse_str(&workspace).unwrap()).bind(owner).execute(&pool).await.unwrap();
      let capture_input=json!({"workspaceId":workspace,"databaseId":default_id,"requestId":Uuid::new_v4(),"sourceExternalId":format!("origin-{source}"),"sourceDocumentId":source,"title":"Keep this original","cells":[]});
      let capture_query="mutation($i:CreateDatabaseTaskFromSourceInput!){createDatabaseTaskFromSource(input:$i){rowId databaseId replayed state record{row{id databaseId title editRevision} cellRevisions{fieldId editRevision}}}}";
      let captured=helpers::gql(&app,session,json!({"query":capture_query,"variables":{"i":capture_input}})).await;
      let captured=gql_data(&captured,&["createDatabaseTaskFromSource"]);
      let row_id=captured["rowId"].as_str().unwrap().to_string();
      let record=&captured["record"];
      let target=&projects[0];
      let target_id=target["database"]["id"].as_str().unwrap();
      let input=json!({"workspaceId":workspace,"sourceDatabaseId":default_id,"targetDatabaseId":target_id,
        "sourceEditRevision":default["editRevision"],"targetEditRevision":target["database"]["editRevision"],
        "sourceSchemaRevision":default["managedSchema"]["schemaRevision"],"targetSchemaRevision":target["managedSchema"]["schemaRevision"],
        "selection":[{"rowId":row_id,"expectedEditRevision":record["row"]["editRevision"],"cellRevisions":record["cellRevisions"].as_array().unwrap().iter().map(|cell|json!({"fieldId":cell["fieldId"],"expectedEditRevision":cell["editRevision"]})).collect::<Vec<_>>()}]});
      let preview=helpers::gql(&app,session,json!({"query":"query($w:String!,$i:DatabaseTaskMoveInput!){workspace(id:$w){prepareDatabaseTaskMove(input:$i){eligible reasons requiredRelatedTasks allocatesDisplayIds}}}","variables":{"w":workspace,"i":input}})).await;
      assert_eq!(gql_data(&preview,&["workspace","prepareDatabaseTaskMove"])["eligible"],true,"{preview:#}");
      let move_query="mutation($i:DatabaseTaskMoveInput!){moveDatabaseTasks(input:$i){sourceDatabaseId targetDatabaseId rows{row{id databaseId title editRevision}}}}";
      let moved=helpers::gql(&app,session,json!({"query":move_query,"variables":{"i":input}})).await;
      let moved=gql_data(&moved,&["moveDatabaseTasks"]);
      assert_eq!(moved["rows"][0]["row"]["id"],row_id);
      assert_eq!(moved["rows"][0]["row"]["databaseId"],target_id);
      assert_eq!(moved["rows"][0]["row"]["title"],"Keep this original");
      let repeated=helpers::gql(&app,session,json!({"query":move_query,"variables":{"i":input}})).await;
      assert_product_rejection(&repeated);
      let recovered=helpers::gql(&app,session,json!({"query":capture_query,"variables":{"i":capture_input}})).await;
      let recovered=gql_data(&recovered,&["createDatabaseTaskFromSource"]);
      assert_eq!(recovered["replayed"],true);
      assert_eq!(recovered["rowId"],row_id);
      assert_eq!(recovered["databaseId"],target_id);
      assert_eq!(recovered["record"]["row"]["databaseId"],target_id);
      let original_url=helpers::gql(&app,session,json!({"query":ROW,"variables":{"w":workspace,"d":default_id,"r":row_id}})).await;
      assert_eq!(gql_data(&original_url,&["workspace","databaseRow"])["row"]["databaseId"],target_id);
      let refs=helpers::gql(&app,session,json!({"query":"query($w:String!,$t:[DatabaseTaskReferenceInput!]!){workspace(id:$w){databaseTaskReferences(targets:$t){databaseId rowId state}}}","variables":{"w":workspace,"t":[{"workspaceId":workspace,"databaseId":default_id,"rowId":row_id}]}})).await;
      assert_eq!(gql_data(&refs,&["workspace","databaseTaskReferences"])[0]["databaseId"],target_id);
      let facts:(Uuid,Uuid,i64)=sqlx::query_as("SELECT receipt.database_id,row.database_id,(SELECT count(*) FROM workspace_database_rows WHERE id=$1) FROM database_task_capture_receipts receipt JOIN workspace_database_rows row ON row.id=receipt.row_id WHERE receipt.row_id=$1")
        .bind(Uuid::parse_str(&row_id).unwrap()).fetch_one(&pool).await.unwrap();
      assert_eq!(facts,(Uuid::parse_str(&default_id).unwrap(),Uuid::parse_str(target_id).unwrap(),1),"capture admission stays immutable while the original Row changes owner");
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
        .bind(Uuid::parse_str(&workspace).unwrap()).bind(owner).execute(&pool).await.unwrap();
      let denied=helpers::gql(&app,session,json!({"query":capture_query,"variables":{"i":capture_input}})).await;
      assert_product_rejection(&denied);
    }).catch_unwind().await;
    finish_database_fixture(&pool, &[owner], body).await;
  });
}

#[test]
fn managed_task_json_copy_and_content_import_preserve_the_descriptor_and_graph() {
  helpers::block_on_large_stack("managed-task-portability", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (owner, session) = helpers::seed_user(&pool, &auth, "managed-task-portability").await;
    let body = AssertUnwindSafe(async {
      let created = helpers::gql(&app, session, json!({"query":"mutation{auth{createWorkspace{id}}}"})).await;
      let workspace=gql_data(&created,&["auth","createWorkspace"])["id"].as_str().unwrap().to_string();
      let page=helpers::gql(&app,session,json!({"query":DESTINATIONS,"variables":{"w":workspace}})).await;
      let default=gql_data(&page,&["workspace","databaseTaskDestinations"])["defaultDestination"].clone();
      let database=default["databaseId"].as_str().unwrap();
      let repo=PgDatabaseRepository::new(pool.clone(),crate::helpers::database_starter_catalog());
      let schema=repo.get_database(database.parse().unwrap()).await.unwrap().unwrap();
      let parent_field=schema.field_roles.iter().find(|role|role.role_key=="task.parent").unwrap().field_id;
      let mut parent=String::new();
      for title in ["Portable parent", "Portable child"] {
        let cells=if parent.is_empty(){json!([])}else{json!([{"fieldId":parent_field,"value":{"relation":[parent]}}])};
        let created=helpers::gql(&app,session,json!({"query":"mutation($i:CreateDatabaseRowInput!){createDatabaseRow(input:$i){row{id}}}","variables":{"i":{"databaseId":database,"title":title,"cells":cells}}})).await;
        let id=gql_data(&created,&["createDatabaseRow"])["row"]["id"].as_str().unwrap().to_string();
        if parent.is_empty(){parent=id;}
      }
      let exported=helpers::gql(&app,session,json!({"query":"query($w:String!,$d:ID!){workspace(id:$w){databaseJsonExport(databaseId:$d){content} databaseCsvExport(databaseId:$d){content}}}","variables":{"w":workspace,"d":database}})).await;
      let content=gql_data(&exported,&["workspace","databaseJsonExport"])["content"].as_str().unwrap();
      assert!(gql_data(&exported,&["workspace","databaseCsvExport"])["content"].as_str().unwrap().contains("Portable child"));
      let snapshot:Value=serde_json::from_str(content).unwrap();
      assert!(snapshot["database"]["managedTemplate"].is_object(),"portable source facts retain descriptor bindings");
      assert_eq!(snapshot["database"]["rows"].as_array().unwrap().len(),2);
      let preview_query="mutation($file:Upload!,$i:PreviewDatabaseJsonImportInput!){previewDatabaseJsonImport(file:$file,input:$i){errors{code message} rowCount}}";
      let import_query="mutation($file:Upload!,$i:ImportDatabaseJsonInput!){importDatabaseJson(file:$file,input:$i){createdRowCount database{database{id systemRole} managedSchema{readiness schemaRevision}}}}";
      let preview=gql_json_upload(&app,session,json!({"query":preview_query,"variables":{"file":null,"i":{"workspaceId":workspace}}}),"tasks.database.json",content.as_bytes()).await;
      assert_eq!(gql_data(&preview,&["previewDatabaseJsonImport"])["errors"],json!([]));
      let roots_before:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_databases WHERE workspace_id=$1").bind(Uuid::parse_str(&workspace).unwrap()).fetch_one(&pool).await.unwrap();
      assert_eq!(roots_before,1,"preview must not allocate a copy");
      let imported=gql_json_upload(&app,session,json!({"query":import_query,"variables":{"file":null,"i":{"workspaceId":workspace}}}),"tasks.database.json",content.as_bytes()).await;
      let imported=gql_data(&imported,&["importDatabaseJson"]);
      assert_eq!(imported["createdRowCount"],2);
      assert!(imported["database"]["database"]["systemRole"].is_null(),"a copied default is an ordinary Project");
      assert_eq!(imported["database"]["managedSchema"]["readiness"],"Ready");
      let copy=Uuid::parse_str(imported["database"]["database"]["id"].as_str().unwrap()).unwrap();
      let copied_edges:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_database_relation_edges WHERE source_database_id=$1 AND target_database_id=$1").bind(copy).fetch_one(&pool).await.unwrap();
      assert_eq!(copied_edges,1,"native parent relation survives portable Row ID remapping");

      let created=helpers::gql(&app,session,json!({"query":"mutation{auth{createWorkspace{id}}}"})).await;
      let target_workspace=gql_data(&created,&["auth","createWorkspace"])["id"].as_str().unwrap().to_string();
      let page=helpers::gql(&app,session,json!({"query":DESTINATIONS,"variables":{"w":target_workspace}})).await;
      let target=gql_data(&page,&["workspace","databaseTaskDestinations"])["defaultDestination"].clone();
      let target_id=target["databaseId"].as_str().unwrap();
      let target_input=json!({"workspaceId":target_workspace,"targetDatabaseId":target_id,"mode":"MERGE","conflictStrategy":"ABORT"});
      let preview=gql_json_upload(&app,session,json!({"query":preview_query,"variables":{"file":null,"i":target_input}}),"tasks.database.json",content.as_bytes()).await;
      assert_eq!(gql_data(&preview,&["previewDatabaseJsonImport"])["errors"],json!([]),"{preview:#}");
      let imported=gql_json_upload(&app,session,json!({"query":import_query,"variables":{"file":null,"i":target_input}}),"tasks.database.json",content.as_bytes()).await;
      let imported=gql_data(&imported,&["importDatabaseJson"]);
      assert_eq!(imported["createdRowCount"],2);
      assert_eq!(imported["database"]["database"]["id"],target_id);
      assert_eq!(imported["database"]["database"]["systemRole"],"WorkspaceTasks");
      assert_eq!(imported["database"]["managedSchema"]["schemaRevision"],target["managedSchema"]["schemaRevision"]);
      let edges:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_database_relation_edges WHERE source_database_id=$1 AND target_database_id=$1").bind(Uuid::parse_str(target_id).unwrap()).fetch_one(&pool).await.unwrap();
      assert_eq!(edges,1);
      let mut invalid=snapshot.clone();
      invalid["database"]["fields"][0]["name"]=json!("Injected user schema");
      let bytes=serde_json::to_vec(&invalid).unwrap();
      let rejected=gql_json_upload(&app,session,json!({"query":preview_query,"variables":{"file":null,"i":target_input}}),"tampered.database.json",&bytes).await;
      assert!(!gql_data(&rejected,&["previewDatabaseJsonImport"])["errors"].as_array().unwrap().is_empty(),"a portable payload cannot author managed structure");
      let rejected=gql_json_upload(&app,session,json!({"query":import_query,"variables":{"file":null,"i":target_input}}),"tampered.database.json",&bytes).await;
      assert_product_rejection(&rejected);
      let row_count:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1").bind(Uuid::parse_str(target_id).unwrap()).fetch_one(&pool).await.unwrap();
      assert_eq!(row_count,2,"failed apply must preserve the whole target");
      let retry=helpers::gql(&app,session,json!({"query":DESTINATIONS,"variables":{"w":target_workspace}})).await;
      assert_eq!(gql_data(&retry,&["workspace","databaseTaskDestinations"])["defaultDestination"]["managedSchema"],target["managedSchema"],"content import does not replace the canonical schema identity");
    }).catch_unwind().await;
    finish_database_fixture(&pool, &[owner], body).await;
  });
}

/// Generic native schema editing makes an observed Select ID obsolete here;
/// the managed YAML conversion itself is covered by the owning SQL fixture.
#[test]
fn obsolete_select_drafts_report_conflicts_before_value_validation() {
  helpers::block_on_large_stack("obsolete-select-draft-conflicts", || async {
    let (app, pool, auth) = helpers::setup_app_with_template_registry_and_search_service().await;
    let (owner, session) = helpers::seed_user(&pool, &auth, "obsolete-select-drafts").await;
    let body = AssertUnwindSafe(async {
      let workspace = helpers::create_workspace(&pool, owner).await;
      let response = helpers::gql(&app, session, json!({
        "query":"mutation($i:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$i){database{id}}}",
        "variables":{"i":{"workspaceId":workspace,"templateId":"myoxus.database.simple_task_list","title":"Obsolete drafts","includeSampleRows":false}}
      })).await;
      let database: Uuid = gql_data(&response, &["createDatabaseFromTemplate"])["database"]["id"].as_str().unwrap().parse().unwrap();
      let repo = PgDatabaseRepository::new(pool.clone(), helpers::database_starter_catalog());
      let schema = repo.get_database(database).await.unwrap().unwrap();
      let field = schema.fields.iter().find(|field| field.field_type == DatabaseFieldType::Select).unwrap();
      let DatabaseFieldConfig::Select(config) = &field.config else { unreachable!() };
      let old = config.options[0].id.clone();
      let target = config.options[1].id.clone();
      let view = schema.views[0].id;
      let response = helpers::gql(&app, session, json!({
        "query":"mutation($i:CreateDatabaseRowInput!){createDatabaseRow(input:$i){row{id}}}",
        "variables":{"i":{"databaseId":database,"title":"Keep native facts","cells":[{"fieldId":field.id,"value":{"select":old}}]}}
      })).await;
      let row: Uuid = gql_data(&response, &["createDatabaseRow"])["row"]["id"].as_str().unwrap().parse().unwrap();
      let first = repo.get_row(row).await.unwrap().unwrap();
      let old_cell_revision = first.cell_revisions.iter().find(|slot| slot.field_id == field.id).unwrap().edit_revision;
      let cell_query = "mutation($i:UpdateDatabaseCellValueInput!){updateDatabaseCellValue(input:$i){editRevision}}";
      let response = helpers::gql(&app, session, json!({"query":cell_query,"variables":{"i":{
        "databaseId":database,"rowId":row,"fieldId":field.id,"value":{"select":target},"expectedEditRevision":old_cell_revision
      }}})).await;
      assert!(gql_errors(&response).is_empty(), "{response:#}");
      let current_row = repo.get_row(row).await.unwrap().unwrap();
      let current_cell_revision = current_row.cell_revisions.iter().find(|slot| slot.field_id == field.id).unwrap().edit_revision;
      let template = repo.list_row_templates(database).await.unwrap().into_iter().next().unwrap();
      let template_query = "mutation($i:UpdateDatabaseRowTemplateInput!){updateDatabaseRowTemplate(input:$i){rowTemplate{editRevision}}}";
      let mut old_values = template.initial_cell_values.clone();
      old_values.insert(field.id, DatabaseCellValueData::Select(old.clone()));
      let template_values = |values: &BTreeMap<Uuid, DatabaseCellValueData>| values.iter().map(|(field,value)| {
        // The native fixture uses Status/Select/Date template defaults. Preserve
        // their complete map through the public typed input representation.
        let value = match value {
          DatabaseCellValueData::Select(value) => json!({"select":value}),
          DatabaseCellValueData::Status(value) => json!({"status":value}),
          DatabaseCellValueData::Date(value) => json!({"date":value}),
          other => panic!("unexpected fixture template value {other:?}"),
        };
        json!({"fieldId":field,"value":value})
      }).collect::<Vec<_>>();
      let response = helpers::gql(&app,session,json!({"query":template_query,"variables":{"i":{
        "rowTemplateId":template.id,"expectedEditRevision":template.edit_revision,"initialCellValues":template_values(&old_values)
      }}})).await;
      assert!(gql_errors(&response).is_empty(), "{response:#}");
      let old_template = repo.get_row_template(template.id).await.unwrap().unwrap();
      let mut next_values = old_values.clone();
      next_values.insert(field.id, DatabaseCellValueData::Select(target.clone()));
      let response = helpers::gql(&app,session,json!({"query":template_query,"variables":{"i":{
        "rowTemplateId":template.id,"expectedEditRevision":old_template.edit_revision,"initialCellValues":template_values(&next_values)
      }}})).await;
      assert!(gql_errors(&response).is_empty(), "{response:#}");
      let state_query = "mutation($i:UpsertDatabaseViewUserStateInput!){upsertDatabaseViewUserState(input:$i){editRevision}}";
      let state_input = |value: &str, revision| json!({"databaseId":database,"viewId":view,"expectedEditRevision":revision,
        "filterTree":{"conjunction":"And","groups":[],"rules":[{"fieldId":field.id,"operator":"Is","value":{"optionId":value}}]}});
      let response = helpers::gql(&app, session, json!({"query":state_query,"variables":{"i":state_input(&old,0)}})).await;
      let old_state_revision = gql_data(&response,&["upsertDatabaseViewUserState"])["editRevision"].as_i64().unwrap();
      let response = helpers::gql(&app, session, json!({"query":state_query,"variables":{"i":state_input(&target,old_state_revision)}})).await;
      assert!(gql_errors(&response).is_empty(), "{response:#}");
      let current_state = repo.get_view_user_state(view,owner).await.unwrap().unwrap();
      let current_template = repo.get_row_template(template.id).await.unwrap().unwrap();
      let response = helpers::gql(&app, session, json!({
        "query":"mutation($i:UpdateDatabaseFieldInput!){updateDatabaseField(input:$i){id}}",
        "variables":{"i":{"databaseId":database,"fieldId":field.id,"expectedEditRevision":field.edit_revision,"config":{"select":{"options":config.options.iter().filter(|option|option.id!=old).map(|option|json!({"id":option.id,"name":option.name,"position":option.position,"colorRole":option.color_role})).collect::<Vec<_>>()}}}}
      })).await;
      assert!(gql_errors(&response).is_empty(), "{response:#}");
      for (query, stale, current_revision, code, kind) in [
        (cell_query,json!({"databaseId":database,"rowId":row,"fieldId":field.id,"value":{"select":old},"expectedEditRevision":old_cell_revision}),current_cell_revision,"MIX_DATABASE_CELL_CONFLICT","cell"),
        (template_query,json!({"rowTemplateId":template.id,"initialCellValues":template_values(&old_values),"expectedEditRevision":old_template.edit_revision}),current_template.edit_revision,"MIX_DATABASE_CONFLICT","rowTemplate"),
        (state_query,state_input(&old,old_state_revision),current_state.edit_revision,"MIX_DATABASE_VIEW_CONFLICT","viewUserState"),
      ] {
        let rejected = helpers::gql(&app,session,json!({"query":query,"variables":{"i":stale}})).await;
        let latest = assert_database_conflict(&rejected, code);
        assert_eq!(latest["kind"],kind,"{rejected:#}");
        if kind == "cell" || kind == "rowTemplate" {
          assert_eq!(latest["editRevision"], current_revision, "canonical conflict readback");
        }
        let mut invalid = stale;
        invalid["expectedEditRevision"] = json!(current_revision);
        if kind == "viewUserState" {
          // Native filters permit unmatched option IDs; malformed operator/value
          // shape is the existing validation contract, not option membership.
          invalid["filterTree"]["rules"][0]["operator"] = json!("Contains");
        }
        let rejected = helpers::gql(&app,session,json!({"query":query,"variables":{"i":invalid}})).await;
        assert_product_rejection(&rejected);
        let validation_code = match kind {
          "rowTemplate" => "MIX_DATABASE_ROW_TEMPLATE_CELL_VALUE_INVALID",
          "viewUserState" => "MIX_DATABASE_VIEW_CONFIG_INVALID",
          _ => "MIX_DATABASE_CELL_VALUE_INVALID",
        };
        assert_eq!(gql_errors(&rejected)[0]["extensions"]["code"],validation_code,"current invalid values remain validation: {rejected:#}");
      }
      for (query,input) in [
        ("mutation($i:BulkSetDatabaseCellValueInput!){bulkSetDatabaseCellValue(input:$i){transactionCommitted}}",json!({"databaseId":database,"fieldId":field.id,"rows":[{"rowId":row,"value":{"select":old},"expectedEditRevision":old_cell_revision}]})),
        ("mutation($i:BulkApplyDatabaseCellPatchesInput!){bulkApplyDatabaseCellPatches(input:$i){transactionCommitted}}",json!({"databaseId":database,"patches":[{"rowId":row,"cells":[{"fieldId":field.id,"value":{"select":old},"expectedEditRevision":old_cell_revision}]}]})),
      ] {
        let rejected=helpers::gql(&app,session,json!({"query":query,"variables":{"i":input}})).await;
        let latest = assert_database_conflict(&rejected, "MIX_DATABASE_BULK_CONFLICT");
        assert_eq!(latest["kind"],"bulk","{rejected:#}");
        let mut invalid = input;
        if invalid.get("rows").is_some() {
          invalid["rows"][0]["expectedEditRevision"] = json!(current_cell_revision);
        } else {
          invalid["patches"][0]["cells"][0]["expectedEditRevision"] = json!(current_cell_revision);
        }
        let rejected=helpers::gql(&app,session,json!({"query":query,"variables":{"i":invalid}})).await;
        assert_product_rejection(&rejected);
        assert_eq!(gql_errors(&rejected)[0]["extensions"]["code"],"MIX_DATABASE_CELL_VALUE_INVALID","{rejected:#}");
      }
      let forced = helpers::gql(&app,session,json!({"query":cell_query,"variables":{"i":{
        "databaseId":database,"rowId":row,"fieldId":field.id,"value":{"select":old},
        "expectedEditRevision":old_cell_revision,"force":true
      }}})).await;
      assert_product_rejection(&forced);
      assert_eq!(gql_errors(&forced)[0]["extensions"]["code"],"MIX_DATABASE_CELL_VALUE_INVALID","force bypasses revision only, not native value validation");
      assert_eq!(serde_json::to_value(repo.get_row(row).await.unwrap().unwrap()).unwrap(),serde_json::to_value(&current_row).unwrap());
      assert_eq!(serde_json::to_value(repo.get_row_template(template.id).await.unwrap().unwrap()).unwrap(),serde_json::to_value(&current_template).unwrap());
      assert_eq!(serde_json::to_value(repo.get_view_user_state(view,owner).await.unwrap().unwrap()).unwrap(),serde_json::to_value(&current_state).unwrap());
    }).catch_unwind().await;
    finish_database_fixture(&pool, &[owner], body).await;
  });
}
