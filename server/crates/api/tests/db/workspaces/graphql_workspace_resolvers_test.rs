//! Invariant tests for P24 WorkspaceType resolvers:
//! pageMeta, histories, recentlyUpdatedDocs, docs(pagination).
//!
//! These resolvers were added in P24 and must return correct data
//! for the frontend to display document metadata, history timelines,
//! and document lists.

use crate::helpers;

use serde_json::json;
use uuid::Uuid;

#[test]
fn contextual_document_api_preserves_native_identity_context_and_current_access() {
  helpers::block_on_large_stack("context-document-api", || async {
    use futures_util::FutureExt;
    use myoxus_application::{
      feature_bundle::assemble_feature_catalogs,
      template_registry::{TemplateRegistryService, TemplateRegistryStore, bundle},
      workspace::assistant_packages::AssistantPackageService,
      workspace_automation::workflows::compile_context_workflow,
    };
    use myoxus_domain::{assistant_package::*, feature_bundle::*, workspace_automation::AutomationExecutionPolicy};
    use myoxus_infrastructure::{
      feature_bundles::{pack_captured_feature_bundle, read_feature_bundle},
      storage::StorageAdapter,
      template_registry::SqlxTemplateRegistryStore,
      workflow_runtime::GlirulusWorkspaceAutomationRuntime,
    };
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, sync::Arc, time::Duration};

    let (_, pool, auth_store, state) = helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let withdrawn_app = myoxus_api::build_router_for_integration_tests(state.clone());
    let (actor, session) = helpers::seed_user(&pool, &auth_store, "context-document-owner").await;
    let (other, other_session) = helpers::seed_user(&pool, &auth_store, "context-document-other").await;
    let slug = format!("test-context-agenda-{}", Uuid::new_v4().simple());
    let filename = format!("{slug}.zip");
    let failpoint = format!("context_placement_{}", Uuid::new_v4().simple());
    let storage_root = tempfile::tempdir().unwrap();
    let storage = Arc::new(StorageAdapter::new_fs(storage_root.path().to_str().unwrap()).unwrap());
    let registry_store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
    let registry =
      Arc::new(TemplateRegistryService::new(registry_store.clone()).with_materialization(state.doc().clone(), storage));
    let mut owned = Vec::new();
    let mut runtime: Option<Arc<GlirulusWorkspaceAutomationRuntime>> = None;
    let outcome = std::panic::AssertUnwindSafe(async {
      // Isolate only the Registry identity. The actual authored native body,
      // typed links and complete Feature admission remain the productive path.
      let sources = helpers::feature_source_set();
      let mut captured = sources.bundles.iter().find(|source| source.pin() == sources.release.base).unwrap().clone();
      let path = "documents/meeting-agenda/1.1.0.zip";
      let mut source = bundle::parse_bundle(&captured.files[path]).unwrap();
      source.manifest.template_id = slug.clone();
      let bytes = bundle::create_export_bundle(&source.manifest, &source.content_bytes, None, &source.localized_contents).unwrap();
      let digest = format!("{:x}", Sha256::digest(&bytes));
      captured.files.insert(path.into(), bytes.clone());
      captured.manifest.files.insert(path.into(), digest.clone());
      let component = captured.manifest.components.iter_mut().find(|component| component.path == path).unwrap();
      component.sha256 = digest;
      component.native_identity.as_mut().unwrap().id = slug.clone();
      let component_id = component.id.clone();
      let isolated_export = format!("{slug}@1.1.0");
      for export in &mut captured.manifest.exports {
        if export.source.component == component_id { export.source.export = isolated_export.clone(); }
      }
      for link in &mut captured.manifest.links {
        if let FeatureLink::DocumentComponent { to: FeatureReference::Local { reference }, .. }
          | FeatureLink::DocumentSource { to: FeatureReference::Local { reference }, .. } = link {
          if reference.component == component_id { reference.export = isolated_export.clone(); }
        }
      }
      // Re-enable one catalog entry only in this isolated fixture. The same
      // native flow remains available when the delivered catalog changes.
      let catalog_path = "assistants/catalog.yaml";
      let mut selection: AssistantPackageCatalogSource = yaml_serde::from_slice(&captured.files[catalog_path]).unwrap();
      // The shipped catalog can move this default to another offered package.
      // Isolate the fixture's context selection as well as its native identity;
      // complete catalog admission must still reject duplicate live defaults.
      for entry in selection.packages.iter_mut().filter(|entry| entry.enabled) {
        entry.default_for.retain(|context| *context != AssistantPackageContext::TaskContainerAssistance);
      }
      let contextual = selection.packages.iter_mut().find(|entry| entry.id == "myoxus.assistant.context.meeting").unwrap();
      contextual.enabled = true;
      contextual.default_for = vec![AssistantPackageContext::TaskContainerAssistance];
      let selection_bytes = yaml_serde::to_string(&selection).unwrap().into_bytes();
      let selection_digest = format!("{:x}", Sha256::digest(&selection_bytes));
      captured.manifest.files.insert(catalog_path.into(), selection_digest.clone());
      captured.manifest.components.iter_mut().find(|component| component.path == catalog_path).unwrap().sha256 = selection_digest;
      captured.files.insert(catalog_path.into(), selection_bytes);
      let fixture = read_feature_bundle(&pack_captured_feature_bundle(&captured.manifest, &captured.files).unwrap()).unwrap();
      let pin = fixture.pin();
      let resolved = assemble_feature_catalogs(
        &FeatureReleaseDescriptor { format_version:1,base:pin.clone() },
        &FeatureBundleCatalogSource {format_version:1,base:pin,optional:vec![],retained:vec![]},
        &[fixture],
      ).unwrap();
      let native = state.database_services().unwrap();
      let packages = Arc::new(AssistantPackageService::new(
        Arc::new(resolved.assistants), Arc::new(resolved.databases), native.definition.clone(), native.views.clone(),
        Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(), helpers::database_starter_catalog())),
        state.config.i18n.default_currency.clone(), state.config.i18n.default_locale.clone(),
      ).with_document_components(state.document_template_service().unwrap(),registry.clone())
        .with_context_workflows_enabled(state.config.workspace_automation.enabled));
      registry.register_shipped_bundle(&bytes,&filename).await.unwrap();
      let automation=state.workspace_automation_service().unwrap().as_ref().clone().with_context_documents(
        Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(),helpers::database_starter_catalog())),
        packages.clone(),Arc::new(state.auth().clone()),
      );
      let limits=automation.limits();
      let policy=AutomationExecutionPolicy {
        max_actions_per_run:u32::try_from(limits.max_actions_per_run).unwrap(),
        max_retry_attempts:u32::try_from(limits.max_retry_attempts.max(1)).unwrap(),
        webhook_timeout_seconds:limits.webhook_timeout_seconds,
      };
      let mut owned_runtime=Arc::new(GlirulusWorkspaceAutomationRuntime::new(pool.clone(),automation.native_executor()));
      runtime=Some(owned_runtime.clone());
      let mut state=state.clone().with_assistant_packages(packages.clone())
        .with_workspace_automation_service(Arc::new(automation.with_runtime(owned_runtime.clone())));
      owned_runtime.readiness().await.unwrap();
      owned_runtime.start().await.unwrap();
      let mut app = myoxus_api::build_router_for_integration_tests(state.clone());
      let workspace = helpers::create_workspace(&pool, actor).await;
      owned.push(workspace);
      // The shared fixture uses ws-<UUID> as its name. Keep authored name prose
      // independent of wire identities so the export assertion tests references.
      sqlx::query("UPDATE workspaces SET name=$2 WHERE id=$1")
        .bind(workspace).bind("Context action workspace").execute(&pool).await.unwrap();
      state.workspace().seed_root_doc(workspace,actor,yjs::create_initial_workspace_doc("Context actions")).await.unwrap();
      let default:Uuid = sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      let project = native.definition.create_project(actor,myoxus_application::database::CreateDatabaseProject {
        workspace_id:workspace,title:"Explicit optional destination".into(),description:None,
        priority_preset:myoxus_domain::database::DatabaseProjectOptionPreset::FiveStep,
        complexity_preset:myoxus_domain::database::DatabaseProjectOptionPreset::FiveStep,
        structure_preset:myoxus_domain::database::DatabaseProjectStructurePreset::TasksOnly,
        default_currency:"EUR".into(),
      }).await.unwrap();
      let task = native.editing.create_row(actor,default,Some("A real selected Task".into()),vec![]).await.unwrap();
      let descriptor = packages.list(AssistantPackageContext::TaskContainerAssistance).into_iter()
        .find(|package|package.document_components.iter().any(|component|component.template_id==slug)).unwrap();
      let database_count:i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_databases WHERE workspace_id=$1")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(database_count,2);
      let listed = helpers::gql(&withdrawn_app, session, json!({"query":"query($w:String!){workspace(id:$w){assistantPackages(context:TaskContainerAssistance){identity{id}}}}","variables":{"w":workspace}})).await;
      assert!(listed.get("errors").is_none(), "{listed}");
      assert!(listed["data"]["workspace"]["assistantPackages"].as_array().unwrap().iter()
        .all(|package| package["identity"]["id"] != descriptor.identity.id),
        "the withdrawn contextual package is never offered; other current packages retain their own admission");
      const PREPARE:&str = "query($w:String!,$input:PrepareContextDocumentsInput!){workspace(id:$w){prepareContextDocuments(input:$input){plan{planDigest documents{title} executionAvailable} assistance{mode source} context{containerTitle taskTitle}}}}";
      const APPLY:&str = "mutation($input:ApplyContextDocumentsInput!){applyContextDocuments(input:$input){requestId status folderId placementComplete documents{componentId reservedDocumentId externalId created placed}}}";
      const READ:&str = "query($w:String!,$request:ID!){workspace(id:$w){contextDocuments(requestId:$request){requestId status folderId placementComplete documents{componentId reservedDocumentId externalId created placed}}}}";
      const RETRY:&str = "mutation($input:RetryContextDocumentsInput!){retryContextDocuments(input:$input){requestId}}";
      // Await the native worker rather than interpreting asynchronous admission
      // as a committed effect or a synchronous placement error.
      async fn wait_context(app:&axum::Router,session:Uuid,workspace:Uuid,request:Uuid,failed:bool)->serde_json::Value {
        tokio::time::timeout(Duration::from_secs(30),async {
          loop {
            let response=helpers::gql(app,session,json!({"query":"query($w:String!,$request:ID!){workspace(id:$w){contextDocuments(requestId:$request){requestId status folderId placementComplete run{status} documents{componentId reservedDocumentId externalId created placed}}}}","variables":{"w":workspace,"request":request}})).await;
            if response.get("errors").is_some() {panic!("native context readback failed: {response}");}
            let value=&response["data"]["workspace"]["contextDocuments"];
            let done=if failed {matches!(value["run"]["status"].as_str(),Some("Failed"|"DeadLetter"))} else {value["status"]=="Ready"};
            if done {
              let mut value=value.clone();
              value.as_object_mut().unwrap().remove("run");
              return value;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
          }
        }).await.expect("native context workflow did not reach its expected outcome")
      }
      for (database,selected_task) in [(default,Some(task.row.id)),(project.database.id,None)] {
        let target=json!({"databaseId":database,"taskId":selected_task});
        let answers=descriptor.inputs.iter().filter_map(|input|match input.target {
          AssistantInputTarget::Title=>Some((input.id.clone(),AssistantValue::Text("Explicit agenda topic".into()))),
          AssistantInputTarget::Description=>Some((input.id.clone(),AssistantValue::Text("Literal notes {{workspace.name}}".into()))),
          AssistantInputTarget::Folder=>Some((input.id.clone(),AssistantValue::Folder(AssistantFolderDestination::New{name:"Explicit action folder".into(),parent:None}))),
          AssistantInputTarget::IncludeComponent=>Some((input.id.clone(),AssistantValue::Boolean(true))),
          _=>None,
        }).collect::<BTreeMap<_,_>>();
        let input=json!({"target":target,"identity":descriptor.identity,"answers":answers,"locale":"en","clientVersion":1});
        let before:(i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE workspace_id=$1),(SELECT count(*) FROM workspace_automation_runs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_automations WHERE workspace_id=$1)")
          .bind(workspace).fetch_one(&pool).await.unwrap();
        let withdrawn = helpers::gql(&withdrawn_app,session,json!({"query":PREPARE,"variables":{"w":workspace,"input":input}})).await;
        assert!(withdrawn.get("errors").is_some(), "disabled catalog entry cannot prepare");
        let prepared=helpers::gql(&app,session,json!({"query":PREPARE,"variables":{"w":workspace,"input":input}})).await;
        assert!(prepared.get("errors").is_none(),"{prepared}");
        let prepared=&prepared["data"]["workspace"]["prepareContextDocuments"];
        assert_eq!(prepared["plan"]["executionAvailable"],true);
        assert_eq!(prepared["context"]["taskTitle"],selected_task.map(|_|json!("A real selected Task")).unwrap_or(serde_json::Value::Null));
        let after:(i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE workspace_id=$1),(SELECT count(*) FROM workspace_automation_runs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_automations WHERE workspace_id=$1)")
          .bind(workspace).fetch_one(&pool).await.unwrap();
        assert_eq!(before,after,"preparation allocates neither content nor receipt");
        let denied=helpers::gql(&app,other_session,json!({"query":PREPARE,"variables":{"w":workspace,"input":input}})).await;
        assert!(denied.get("errors").is_some(),"unrelated user cannot prepare against this container");
        helpers::add_workspace_member(&pool,workspace,other).await;
        sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
          .bind(workspace).bind(other).execute(&pool).await.unwrap();
        let request=Uuid::new_v4();
        let mut apply=input.clone();
        apply["workspaceId"]=json!(workspace);apply["requestId"]=json!(request);
        apply["planDigest"]=prepared["plan"]["planDigest"].clone();
        let withdrawn = helpers::gql(&withdrawn_app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
        assert!(withdrawn.get("errors").is_some(), "a prepared identity cannot bypass catalog withdrawal");
        let denied_counts:(i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE workspace_id=$1),(SELECT count(*) FROM workspace_automation_runs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_automations WHERE workspace_id=$1)")
          .bind(workspace).fetch_one(&pool).await.unwrap();
        assert_eq!(before,denied_counts,"withdrawn starts allocate no content, receipt, workflow or rule");
        let denied_apply=helpers::gql(&app,other_session,json!({"query":APPLY,"variables":{"input":apply}})).await;
        assert!(denied_apply.get("errors").is_some(),"read-only membership cannot create documents");
        sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
          .bind(workspace).bind(other).execute(&pool).await.unwrap();
        let mut partial_id=None;
        let mut edited_partial=None;
        let mut retained_entry=None;
        if selected_task.is_some() {
          // Fail only this fixture's real Organizer write, after Created is durable.
          sqlx::query(&format!("CREATE FUNCTION {failpoint}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.workspace_id='{workspace}'::uuid
              AND EXISTS(SELECT 1 FROM docs WHERE id=NEW.doc_id AND external_id='db${workspace}$folders')
              AND EXISTS(SELECT 1 FROM workspace_starter_applications WHERE workspace_id='{workspace}'::uuid
                AND operation='prepare_documents' AND project_progress->'documents'<>'{{}}'::jsonb)
            THEN RAISE EXCEPTION 'owned context placement interruption'; END IF; RETURN NEW; END $$"))
            .execute(&pool).await.unwrap();
          sqlx::query(&format!("CREATE TRIGGER {failpoint} BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION {failpoint}()"))
            .execute(&pool).await.unwrap();
          let interrupted=helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
          assert!(interrupted.get("errors").is_none(),"native placement is admitted asynchronously: {interrupted}");
          let partial=wait_context(&app,session,workspace,request,true).await;
          assert_eq!(partial["status"],"Pending");
          assert_eq!(partial["documents"][0]["created"],true);
          assert_eq!(partial["documents"][0]["placed"],false);
          let doc=Uuid::parse_str(partial["documents"][0]["reservedDocumentId"].as_str().unwrap()).unwrap();
          partial_id=Some(doc);
          sqlx::query(&format!("DROP TRIGGER {failpoint} ON doc_updates")).execute(&pool).await.unwrap();
          sqlx::query(&format!("DROP FUNCTION {failpoint}()" )).execute(&pool).await.unwrap();
          state.doc().page_lifecycle.rename(workspace,doc,actor,"Edited after Created".into(),None).await.unwrap();
          edited_partial=Some(state.doc().load_full_doc_consistent(workspace,doc).await.unwrap());
          let entry=registry_store.get_catalog_entry_by_slug(&slug).await.unwrap().unwrap();
          let mut disabled=entry.clone();
          disabled.status=myoxus_domain::template_registry::TemplateStatus::Disabled;
          registry_store.update_catalog_entry(&disabled).await.unwrap();
          retained_entry=Some(entry);
          sqlx::query("UPDATE docs SET blocked=TRUE WHERE workspace_id=$1 AND id=$2")
            .bind(workspace).bind(doc).execute(&pool).await.unwrap();
          let blocked=helpers::gql(&app,session,json!({"query":RETRY,"variables":{"input":{"workspaceId":workspace,"requestId":request}}})).await;
          assert!(blocked.get("errors").is_some(),"blocked result cannot acquire a remaining placement ACK");
          let progress:serde_json::Value=sqlx::query_scalar("SELECT project_progress FROM workspace_starter_applications WHERE actor_id=$1 AND operation='prepare_documents' AND request_id=$2")
            .bind(actor).bind(request).fetch_one(&pool).await.unwrap();
          assert_eq!(progress["documents"][&descriptor.document_components[0].component_id]["placed"],false);
          assert_eq!(progress["placementComplete"],false);
          sqlx::query("UPDATE docs SET blocked=FALSE WHERE workspace_id=$1 AND id=$2")
            .bind(workspace).bind(doc).execute(&pool).await.unwrap();
          let retry=helpers::gql(&app,session,json!({"query":RETRY,"variables":{"input":{"workspaceId":workspace,"requestId":request}}})).await;
          if retry.get("errors").is_some() {panic!("native retry rejected after repair: {retry}");}
        }
        let (first,second)=tokio::join!(
          helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})),
          helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})),
        );
        assert!(first.get("errors").is_none(),"{first}");
        assert!(second.get("errors").is_none(),"{second}");
        let identity=|value:&serde_json::Value|(value["requestId"].clone(),value["folderId"].clone(),value["documents"].as_array().unwrap().iter().map(|doc|doc["reservedDocumentId"].clone()).collect::<Vec<_>>());
        assert_eq!(identity(&first["data"]["applyContextDocuments"]),identity(&second["data"]["applyContextDocuments"]),"same native action returns exactly the same identities");
        let first=wait_context(&app,session,workspace,request,false).await;
        let first=&first;
        assert_eq!(first["status"],"Ready");assert_eq!(first["placementComplete"],true);
        let documents=first["documents"].as_array().unwrap();assert_eq!(documents.len(),1);
        assert_eq!(documents[0]["created"],true);assert_eq!(documents[0]["placed"],true);
        let doc_id=Uuid::parse_str(documents[0]["reservedDocumentId"].as_str().unwrap()).unwrap();
        assert_eq!(documents[0]["externalId"],doc_id.to_string());
        let leaf=state.doc().load_full_doc_consistent(workspace,doc_id).await.unwrap();
        if let Some(partial)=partial_id {
          assert_eq!(doc_id,partial,"placement retry retains its reserved document identity");
          assert_eq!(Some(&leaf),edited_partial.as_ref(),"late placement never replaces edits after Created");
        }
        if let Some(entry)=retained_entry {registry_store.update_catalog_entry(&entry).await.unwrap();}
        assert!(yjs::inspect_native_template_references(&leaf).unwrap().is_empty(),"working copy has no unbound slots");
        {
          use yrs::{Map,Text,Transact,updates::decoder::Decode};
          let doc=yrs::Doc::new();
          doc.transact_mut().apply_update(yrs::Update::decode_v1(&leaf).unwrap()).unwrap();
          let map=doc.get_or_insert_map("blocks");
          let tx=doc.transact();
          let bold_topic=map.iter(&tx).any(|(_,value)|match value {
            yrs::Out::YMap(block)=>match block.get(&tx,"prop:text") {
              Some(yrs::Out::YText(text))=>text.diff(&tx,yrs::types::text::YChange::identity).iter().any(|run| {
                matches!(&run.insert,yrs::Out::Any(yrs::Any::String(value)) if value.as_ref()=="Explicit agenda topic")
                  && run.attributes.as_deref().and_then(|attributes|attributes.get("bold"))==Some(&yrs::Any::Bool(true))
              }),
              _=>false,
            },
            _=>false,
          });
          assert!(bold_topic,"literal preparation must retain the source topic's native bold formatting");
          let references=map.iter(&tx).filter_map(|(_,value)|match value {
            yrs::Out::YMap(block) if block.get(&tx,"prop:serverReferencePresentation").is_some()=>Some(block),
            _=>None,
          }).collect::<Vec<_>>();
          assert_eq!(references.len(),if selected_task.is_some(){2}else{1},"actual contextual references must exist before opening");
          let mut task_references=0;
          for block in references {
            assert_eq!(block.get(&tx,"prop:serverWorkspaceId").unwrap().to_string(&tx),workspace.to_string());
            assert_eq!(block.get(&tx,"prop:serverDatabaseId").unwrap().to_string(&tx),database.to_string());
            assert_eq!(block.get(&tx,"prop:serverReferencePresentation").unwrap().to_string(&tx),"compact");
            assert!(block.get(&tx,"prop:templateReference").is_none());
            if let Some(row)=block.get(&tx,"prop:serverRowId") {
              assert_eq!(Some(row.to_string(&tx)),selected_task.map(|id|id.to_string()));
              task_references+=1;
            }
          }
          assert_eq!(task_references,usize::from(selected_task.is_some()));
        }
        // The canonical exporter includes native Table cells; the version-diff
        // prose projection deliberately omits them and rich-text attributes.
        let contents=myoxus_application::markdown::yjs_to_markdown(&leaf).unwrap().unwrap();
        assert!(contents.markdown.contains("Explicit agenda topic")&&contents.markdown.contains("Literal notes {{workspace.name}}"),"native body preserves literal reviewed values: {}",contents.markdown);
        assert!(contents.markdown.contains("Context action workspace"),"authored workspace name remains normal copy content");
        for private_id in [workspace,database] {assert!(!contents.markdown.contains(&private_id.to_string()),"public export cannot disclose private context IDs");}
        let read=helpers::gql(&app,session,json!({"query":READ,"variables":{"w":workspace,"request":request}})).await;
        assert!(read.get("errors").is_none(),"{read}");assert_eq!(read["data"]["workspace"]["contextDocuments"]["status"],"Ready");
        state.doc().page_lifecycle.rename(workspace,doc_id,actor,"User edited working copy".into(),None).await.unwrap();
        let edited=state.doc().load_full_doc_consistent(workspace,doc_id).await.unwrap();
        let replay=helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
        assert!(replay.get("errors").is_none(),"{replay}");assert_eq!(replay["data"]["applyContextDocuments"],*first);
        assert_eq!(state.doc().load_full_doc_consistent(workspace,doc_id).await.unwrap(),edited,"replay never replaces edits");
        let mut changed=apply.clone();changed["target"]["taskId"]=json!(Uuid::new_v4());
        let conflict=helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":changed}})).await;
        assert_eq!(conflict["errors"][0]["extensions"]["code"],"MIX_ASSISTANT_REQUEST_CONFLICT");
        let foreign=helpers::gql(&app,other_session,json!({"query":READ,"variables":{"w":workspace,"request":request}})).await;
        assert!(foreign.get("errors").is_some(),"receipt cannot grant workspace access to another person");
        if selected_task.is_none() {
          // This pre-write Stop fixture owns the worker lifecycle so its queued
          // receipt cannot race execution before the explicit Stop command.
          owned_runtime.shutdown(Duration::from_secs(30)).await.unwrap();
          use myoxus_application::workspace::{ContextDocumentStarterInput,WorkspaceStore};
          let stopped_request=Uuid::new_v4();
          let prepared_native=packages.prepare_context_documents(actor,workspace,
            ContextDocumentTarget {database_id:database,task_id:None},&descriptor.identity,
            answers.clone(),"en",1,state.auth()).await.unwrap();
          let stopped_input=ContextDocumentStarterInput {
            request_id:stopped_request,package:descriptor.identity.clone(),answers:answers.clone(),
            locale:"en".into(),client_version:1,plan_digest:prepared_native.plan_digest.clone(),admission_confirmation:None,
          };
          let store=myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(),helpers::database_starter_catalog());
          let admission=myoxus_application::workspace::assistant_packages::context_documents_admission(&prepared_native.plan);
          let definition=compile_context_workflow(&prepared_native.plan,policy.clone()).unwrap();
          let reserved=store.accept_context_documents(actor,workspace,stopped_request,
            &stopped_input.fingerprint(workspace,&prepared_native.plan.target),prepared_native.plan,admission,definition).await.unwrap();
          let before_stop:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
          let stopped=helpers::gql(&app,session,json!({
            "query":"mutation($input:StopContextDocumentsInput!){stopContextDocuments(input:$input){requestId status documents{reservedDocumentId created placed}}}",
            "variables":{"input":{"workspaceId":workspace,"requestId":stopped_request}},
          })).await;
          assert!(stopped.get("errors").is_none(),"{stopped}");
          assert_eq!(stopped["data"]["stopContextDocuments"]["status"],"Stopped");
          let mut replay_stopped=apply.clone();replay_stopped["requestId"]=json!(stopped_request);
          replay_stopped["planDigest"]=json!(stopped_input.plan_digest);
          let replay_stopped=helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":replay_stopped}})).await;
          assert!(replay_stopped.get("errors").is_none(),"{replay_stopped}");
          assert_eq!(replay_stopped["data"]["applyContextDocuments"]["status"],"Stopped");
          assert_eq!(replay_stopped["data"]["applyContextDocuments"]["documents"][0]["reservedDocumentId"],reserved.ids.documents[0].doc_id.to_string());
          assert_eq!(replay_stopped["data"]["applyContextDocuments"]["documents"][0]["created"],false);
          let after_stop:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
          assert_eq!(after_stop,before_stop,"Stop before writes remains terminal and cannot seed a copy on replay");
          let automation=state.workspace_automation_service().unwrap().as_ref().clone();
          owned_runtime=Arc::new(GlirulusWorkspaceAutomationRuntime::new(pool.clone(),automation.native_executor()));
          runtime=Some(owned_runtime.clone());
          state=state.with_workspace_automation_service(Arc::new(automation.with_runtime(owned_runtime.clone())));
          app=myoxus_api::build_router_for_integration_tests(state.clone());
          owned_runtime.readiness().await.unwrap();
          owned_runtime.start().await.unwrap();
        }
        if selected_task.is_some() {
          state.doc().page_lifecycle.trash(workspace,doc_id,actor).await.unwrap();
          let gone=helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
          assert!(gone.get("errors").is_none(),"{gone}");
          let gone=&gone["data"]["applyContextDocuments"];
          assert_eq!(gone["status"],"Unavailable");
          assert_eq!(gone["documents"][0]["reservedDocumentId"],documents[0]["reservedDocumentId"]);
          assert!(gone["documents"][0]["externalId"].is_null(),"trashed copy has no actionable current link");
          let copies:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND id=$2")
            .bind(workspace).bind(doc_id).fetch_one(&pool).await.unwrap();
          assert_eq!(copies,1,"replay of a removed result does not create a replacement");
        }
      }
      // Exercise the real accepted-receipt frontier independently of readonly
      // preparation. No synthetic progress or document bodies are persisted.
      {
        use myoxus_application::workspace::{ContextDocumentStarterInput, WorkspaceStore};
        use myoxus_domain::database::{DatabaseTaskMoveInput, DatabaseTaskMoveSelection};
        let store = myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(),helpers::database_starter_catalog());
        for fence in ["stop_after_created", "move_before_placement", "people_before_created"] {
          let selected = if fence=="move_before_placement" {
            Some(native.editing.create_row(actor,default,Some("Explicit move-fenced Task".into()),vec![]).await.unwrap().row.id)
          } else { None };
          let target=ContextDocumentTarget {database_id:default,task_id:selected};
          let mut answers=descriptor.inputs.iter().filter_map(|input|match input.target {
            AssistantInputTarget::Title=>Some((input.id.clone(),AssistantValue::Text(format!("Native fence: {fence}")))),
            AssistantInputTarget::Description=>Some((input.id.clone(),AssistantValue::Text("Preserved explicit content".into()))),
            AssistantInputTarget::Folder=>Some((input.id.clone(),AssistantValue::Folder(AssistantFolderDestination::New{name:format!("Native fence {fence}"),parent:None}))),
            AssistantInputTarget::IncludeComponent=>Some((input.id.clone(),AssistantValue::Boolean(true))),
            _=>None,
          }).collect::<BTreeMap<_,_>>();
          if fence=="people_before_created" {
            helpers::add_workspace_member(&pool,workspace,other).await;
            let people=descriptor.inputs.iter().find(|input|input.target==AssistantInputTarget::People).expect("authored explicit people input");
            answers.insert(people.id.clone(),AssistantValue::Members(vec![other]));
          }
          let prepared=packages.prepare_context_documents(actor,workspace,target.clone(),&descriptor.identity,answers.clone(),"en",1,state.auth()).await.unwrap();
          let input=ContextDocumentStarterInput {request_id:Uuid::new_v4(),package:descriptor.identity.clone(),answers:answers.clone(),locale:"en".into(),client_version:1,plan_digest:prepared.plan_digest.clone(),admission_confirmation:None};
          let admission=myoxus_application::workspace::assistant_packages::context_documents_admission(&prepared.plan);
          let definition=compile_context_workflow(&prepared.plan,policy.clone()).unwrap();
          let accepted=store.accept_context_documents(actor,workspace,input.request_id,&input.fingerprint(workspace,&target),prepared.plan,admission.clone(),definition).await.unwrap();
          let apply=json!({"workspaceId":workspace,"requestId":input.request_id,"target":target,"identity":descriptor.identity,"answers":answers,"locale":"en","clientVersion":1,"planDigest":input.plan_digest});
          let reserved=accepted.ids.documents[0].doc_id;
          let component=&accepted.ids.documents[0].component_id;
          if fence=="people_before_created" {
            let before:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
            state.workspace().revoke_member(workspace,other).await.unwrap();
            assert!(store.review_context_documents(&accepted,admission).await.is_err(),"same SQL accepted-member fence rejects revoked selected person");
            helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
            let denied=wait_context(&app,session,workspace,input.request_id,true).await;
            assert_eq!(denied["status"],"Unavailable","frozen names do not authorize publication after membership revocation");
            let after:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
            assert_eq!(after,before,"revocation before the first child commit creates neither folder nor leaf");
            let progress:serde_json::Value=sqlx::query_scalar("SELECT project_progress FROM workspace_starter_applications WHERE actor_id=$1 AND operation='prepare_documents' AND request_id=$2").bind(actor).bind(input.request_id).fetch_one(&pool).await.unwrap();
            assert_eq!(progress["documents"],json!({}));assert_eq!(progress["folderReady"],false);assert_eq!(progress["placementComplete"],false);
          } else {
            sqlx::query(&format!("CREATE FUNCTION {failpoint}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              IF NEW.workspace_id='{workspace}'::uuid
                AND EXISTS(SELECT 1 FROM docs WHERE id=NEW.doc_id AND external_id='db${workspace}$folders')
                AND EXISTS(SELECT 1 FROM workspace_starter_applications WHERE actor_id='{actor}'::uuid
                  AND operation='prepare_documents' AND request_id='{}'::uuid AND project_progress->'documents'<>'{{}}'::jsonb)
              THEN RAISE EXCEPTION 'owned context placement interruption'; END IF; RETURN NEW; END $$",input.request_id)).execute(&pool).await.unwrap();
            sqlx::query(&format!("CREATE TRIGGER {failpoint} BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION {failpoint}()")).execute(&pool).await.unwrap();
            helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
            wait_context(&app,session,workspace,input.request_id,true).await;
            sqlx::query(&format!("DROP TRIGGER {failpoint} ON doc_updates")).execute(&pool).await.unwrap();
            sqlx::query(&format!("DROP FUNCTION {failpoint}()")).execute(&pool).await.unwrap();
            let partial=store.get_context_documents(actor,workspace,input.request_id,None).await.unwrap().unwrap();
            assert!(partial.progress.documents.contains_key(component));assert!(!partial.progress.documents[component].placed);assert!(!partial.progress.placement_complete);
            let original=state.doc().load_full_doc_consistent(workspace,reserved).await.unwrap();
            if fence=="stop_after_created" {
              let stopped=helpers::gql(&app,session,json!({"query":"mutation($input:StopContextDocumentsInput!){stopContextDocuments(input:$input){status documents{reservedDocumentId externalId created placed}}}","variables":{"input":{"workspaceId":workspace,"requestId":input.request_id}}})).await;
              assert!(stopped.get("errors").is_none(),"{stopped}");assert_eq!(stopped["data"]["stopContextDocuments"]["status"],"Stopped");
              assert_eq!(stopped["data"]["stopContextDocuments"]["documents"][0]["created"],true);
              assert_eq!(stopped["data"]["stopContextDocuments"]["documents"][0]["placed"],false);
              assert_eq!(stopped["data"]["stopContextDocuments"]["documents"][0]["externalId"],reserved.to_string());
            } else {
              let source=native.definition.get_database(actor,default).await.unwrap();
              let destination=native.definition.get_database(actor,project.database.id).await.unwrap();
              let row=native.views.get_row_for_read(actor,default,selected.unwrap(),false).await.unwrap().unwrap();
              let movement=DatabaseTaskMoveInput {
                workspace_id:workspace,source_database_id:default,target_database_id:project.database.id,
                source_edit_revision:source.database.edit_revision,target_edit_revision:destination.database.edit_revision,
                source_schema_revision:source.database.managed_installation.as_ref().unwrap().schema_revision,
                target_schema_revision:destination.database.managed_installation.as_ref().unwrap().schema_revision,
                selection:vec![DatabaseTaskMoveSelection {row_id:row.row.id,expected_edit_revision:row.row.edit_revision,cell_revisions:row.cell_revisions.iter().map(|cell|(cell.field_id,cell.edit_revision)).collect()}],
                phase_row_id:None,milestone_row_id:None,
              };
              let preview=native.editing.prepare_task_move(actor,movement.clone()).await.unwrap();
              assert!(preview.eligible,"native move must be valid: {:?}",preview.reasons);
              let moved=native.editing.move_tasks(actor,movement).await.unwrap();
              assert_eq!(moved.rows[0].row.id,selected.unwrap());assert_eq!(moved.rows[0].row.database_id,project.database.id);
              assert!(store.review_context_documents(&partial,partial.admission.clone()).await.is_err(),"locked target admission rejects the now foreign-container Task");
            }
            let replay=helpers::gql(&app,session,json!({"query":APPLY,"variables":{"input":apply}})).await;
            assert!(replay.get("errors").is_none(),"{replay}");
            let replay=&replay["data"]["applyContextDocuments"];
            assert_eq!(replay["status"],if fence=="stop_after_created" {"Stopped"} else {"Unavailable"});
            assert_eq!(replay["documents"][0]["reservedDocumentId"],reserved.to_string());assert_eq!(replay["documents"][0]["created"],true);assert_eq!(replay["documents"][0]["placed"],false);
            assert_eq!(state.doc().load_full_doc_consistent(workspace,reserved).await.unwrap(),original,"neither Stop nor moved context replaces an acknowledged working copy");
            let final_receipt=store.get_context_documents(actor,workspace,input.request_id,None).await.unwrap().unwrap();
            assert!(!final_receipt.progress.documents[component].placed);assert!(!final_receipt.progress.placement_complete);
          }
          let copies:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1 AND id=$2").bind(workspace).bind(reserved).fetch_one(&pool).await.unwrap();
          assert_eq!(copies,if fence=="people_before_created" {0} else {1},"fixed result identity is never reallocated");
        }
      }
      let final_count:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_databases WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(final_count,database_count,"preparation never creates a Project or another default");
      let allocations:(i64,i64)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE operation='prepare_documents') FROM workspace_starter_applications WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(allocations,(6,6),"each explicit action has one receipt in the existing ledger");
    }).catch_unwind().await;
    let shutdown = match runtime {
      Some(runtime) => runtime.shutdown(Duration::from_secs(30)).await,
      None => Ok(()),
    };
    sqlx::query(&format!("DROP TRIGGER IF EXISTS {failpoint} ON doc_updates"))
      .execute(&pool)
      .await
      .expect("owned failpoint trigger cleanup");
    sqlx::query(&format!("DROP FUNCTION IF EXISTS {failpoint}()"))
      .execute(&pool)
      .await
      .expect("owned failpoint function cleanup");
    helpers::cleanup_workspaces(&pool, &owned).await;
    helpers::cleanup_users(&pool, &[actor, other]).await;
    let jobs:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT import_job_id FROM template_registry_audit_events WHERE payload_json->>'filename'=$1 AND import_job_id IS NOT NULL").bind(&filename).fetch_all(&pool).await.expect("owned source import jobs");
    sqlx::query("DELETE FROM template_registry_audit_events WHERE import_job_id=ANY($1)")
      .bind(&jobs)
      .execute(&pool)
      .await
      .expect("owned source import audits cleanup");
    sqlx::query("DELETE FROM template_import_jobs WHERE id=ANY($1)")
      .bind(&jobs)
      .execute(&pool)
      .await
      .expect("owned source import jobs cleanup");
    if let Some(entry) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM template_catalog_entries WHERE slug=$1")
      .bind(&slug)
      .fetch_optional(&pool)
      .await
      .unwrap()
    {
      registry_store
        .delete_catalog_entry(entry)
        .await
        .expect("owned source cleanup after receipt cleanup");
    }
    let remaining:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=ANY($1)) OR EXISTS(SELECT 1 FROM users WHERE id=ANY($2)) OR EXISTS(SELECT 1 FROM workspace_starter_applications WHERE actor_id=ANY($2))")
      .bind(&owned).bind(vec![actor,other]).fetch_one(&pool).await.expect("verify owned fixture cleanup");
    assert!(
      !remaining,
      "context fixtures must leave no workspaces, users or receipts"
    );
    if let Err(error) = outcome {
      std::panic::resume_unwind(error);
    }
    shutdown.expect("owned native context worker shutdown");
  });
}

#[derive(Default)]
struct ManagedUpdateNotifications(std::sync::atomic::AtomicUsize);
#[async_trait::async_trait]
impl myoxus_application::ports::database_change::DatabaseChangeNotificationPort for ManagedUpdateNotifications {
  async fn publish_change(
    &self,
    _: &myoxus_domain::database_change::DatabaseChangeEvent,
  ) -> myoxus_application::ports::PortResult<()> {
    self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(())
  }
  async fn publish_tasks_changed(
    &self,
    _: &myoxus_domain::database_change::DatabaseChangeEvent,
  ) -> myoxus_application::ports::PortResult<()> {
    self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(())
  }
}

// ─── pageMeta ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_page_meta_returns_author_info() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  // Create a workspace + doc
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": "mutation { auth { createWorkspace { id } } }"}),
  )
  .await;
  let ws_id = resp["data"]["auth"]["createWorkspace"]["id"]
    .as_str()
    .expect("createWorkspace id must be a string")
    .to_string();

  // Create a doc via the docs table directly
  let doc_id = Uuid::new_v4();
  let ws_uuid: Uuid = ws_id.parse().expect("workspace id must be a valid UUID");
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, 'Test Page', $3, $3)",
  )
  .bind(doc_id)
  .bind(ws_uuid)
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("insert doc");

  // Query pageMeta
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": format!(
        "{{ workspace(id: \"{ws_id}\") {{ pageMeta(pageId: \"{doc_id}\") {{ createdAt createdBy {{ name }} }} }} }}"
      )
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "pageMeta error: {resp}");
  let meta = &resp["data"]["workspace"]["pageMeta"];
  assert!(meta["createdAt"].is_string(), "createdAt must be set");
  assert!(meta["createdBy"]["name"].is_string(), "createdBy.name must be set");

  // Cleanup
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── recentlyUpdatedDocs ─────────────────────────────────────────────────────

#[tokio::test]
async fn inv_recently_updated_docs_returns_original_ids() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": "mutation { auth { createWorkspace { id } } }"}),
  )
  .await;
  let ws_id = resp["data"]["auth"]["createWorkspace"]["id"]
    .as_str()
    .expect("createWorkspace id must be a string")
    .to_string();
  let ws_uuid: Uuid = ws_id.parse().expect("workspace id must be a valid UUID");

  // Insert a doc with an external_id (nanoid-style)
  let doc_uuid = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title, external_id, created_by, updated_by) VALUES ($1, $2, 'Nanoid Doc', 'testNanoidPage123', $3, $3)")
    .bind(doc_uuid)
    .bind(ws_uuid)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("insert doc");
  sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $2, $3, 0)")
    .bind(doc_uuid)
    .bind(ws_uuid)
    .bind(yjs::merge_updates(Vec::new()).expect("empty Yjs snapshot"))
    .execute(&pool)
    .await
    .expect("insert doc snapshot");

  // Query recentlyUpdatedDocs
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": format!(
        "{{ workspace(id: \"{ws_id}\") {{ recentlyUpdatedDocs(pagination: {{ first: 10 }}) {{ edges {{ node {{ id title }} }} }} }} }}"
      )
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "recentlyUpdatedDocs error: {resp}");
  let edges = resp["data"]["workspace"]["recentlyUpdatedDocs"]["edges"]
    .as_array()
    .expect("recentlyUpdatedDocs edges must be an array");

  // The doc must appear with its ORIGINAL nanoid ID, not the UUID
  let ids: Vec<&str> = edges.iter().filter_map(|e| e["node"]["id"].as_str()).collect();
  assert!(
    ids.contains(&"testNanoidPage123"),
    "recentlyUpdatedDocs must return external_id, got: {ids:?}"
  );

  // Cleanup
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── docs(pagination) ────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_docs_pagination_returns_total_count() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": "mutation { auth { createWorkspace { id } } }"}),
  )
  .await;
  let ws_id = resp["data"]["auth"]["createWorkspace"]["id"]
    .as_str()
    .expect("createWorkspace id must be a string")
    .to_string();
  let ws_uuid: Uuid = ws_id.parse().expect("workspace id must be a valid UUID");

  // Insert three content-bearing docs. Metadata-only rows are intentionally
  // excluded from user-facing document lists until sync persists content.
  for i in 0..3 {
    let doc_id = Uuid::new_v4();
    sqlx::query("INSERT INTO docs (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)")
      .bind(doc_id)
      .bind(ws_uuid)
      .bind(format!("Doc {i}"))
      .bind(admin_id)
      .execute(&pool)
      .await
      .expect("insert doc");
    sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $2, $3, 0)")
      .bind(doc_id)
      .bind(ws_uuid)
      .bind(yjs::merge_updates(Vec::new()).expect("empty Yjs snapshot"))
      .execute(&pool)
      .await
      .expect("insert doc snapshot");
  }

  // Query docs with pagination
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": format!(
        "{{ workspace(id: \"{ws_id}\") {{ docs(pagination: {{ first: 2 }}) {{ totalCount pageInfo {{ hasNextPage }} edges {{ node {{ id }} }} }} }} }}"
      )
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "docs error: {resp}");
  let docs = &resp["data"]["workspace"]["docs"];
  assert_eq!(
    docs["totalCount"].as_i64().expect("totalCount must be a number"),
    3,
    "totalCount must be 3"
  );
  assert_eq!(
    docs["edges"].as_array().expect("docs edges must be an array").len(),
    2,
    "edges must have 2 items (first: 2)"
  );
  assert!(
    docs["pageInfo"]["hasNextPage"]
      .as_bool()
      .expect("hasNextPage must be a boolean"),
    "hasNextPage must be true"
  );

  // Cleanup
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
}

// ─── histories ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn inv_histories_returns_empty_for_no_snapshots() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({"query": "mutation { auth { createWorkspace { id } } }"}),
  )
  .await;
  let ws_id = resp["data"]["auth"]["createWorkspace"]["id"]
    .as_str()
    .expect("createWorkspace id must be a string")
    .to_string();
  let ws_uuid: Uuid = ws_id.parse().expect("workspace id must be a valid UUID");

  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO docs (id, workspace_id, title, created_by) VALUES ($1, $2, 'History Test', $3)")
    .bind(doc_id)
    .bind(ws_uuid)
    .bind(admin_id)
    .execute(&pool)
    .await
    .expect("insert doc");

  // Query histories — should be empty (no history snapshots created)
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": format!(
        "{{ workspace(id: \"{ws_id}\") {{ histories(guid: \"{doc_id}\", take: 5) {{ id timestamp }} }} }}"
      )
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "histories error: {resp}");
  let histories = resp["data"]["workspace"]["histories"]
    .as_array()
    .expect("histories must be an array");
  assert!(histories.is_empty(), "histories must be empty when no snapshots exist");

  // Cleanup
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(ws_uuid)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(admin_id)
    .execute(&pool)
    .await
    .ok();
}

#[test]
fn explicit_empty_workspace_allocation_and_assistance_ack_are_replay_safe() {
  helpers::block_on_large_stack("empty-workspace-starter", || async {
    use futures_util::FutureExt;
    use myoxus_application::auth::{AssistanceMode, AuthStore};
    use myoxus_application::workspace::assistant_packages::{
      AssistantPackageCatalog, AssistantPackageInventory, AssistantPackageService,
    };
    use myoxus_application::workspace::{
      WorkspaceInitialContent, WorkspaceStarterInput, WorkspaceStarterReceipt, WorkspaceStore,
    };
    use myoxus_domain::assistant_package::{
      AssistantInputTarget, AssistantNativeAction, AssistantPackageContext, AssistantPackageIdentity, AssistantValue,
    };
    use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseProfileKind, DatabaseTemplateSourceRole};
    use std::sync::Arc;
    let (app, pool, auth_store, state) = helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let (user, session) = helpers::seed_user(&pool, &auth_store, "empty-workspace-owner").await;
    let (other, other_session) = helpers::seed_user(&pool, &auth_store, "empty-workspace-other").await;
    let mut owned_workspaces = Vec::new();
    let outcome = std::panic::AssertUnwindSafe(async {
      let listed = helpers::gql(&app, session, json!({"query":"{currentUser{assistantPackages(context:WorkspaceCreation){identity{id version digest} inputs{id target choices{id value{choice text}}}}}}"})).await;
      assert!(listed.get("errors").is_none(), "{listed}");
      assert_eq!(listed["data"]["currentUser"]["assistantPackages"].as_array().unwrap().len(), 1,
        "Workspace creation exposes only the declared native Empty default");
      let descriptor = &listed["data"]["currentUser"]["assistantPackages"][0];
      let identity_json = descriptor["identity"].clone();
      let identity: AssistantPackageIdentity = serde_json::from_value(identity_json.clone()).unwrap();
      let name = format!("Empty {}", Uuid::new_v4());
      let mut answers = serde_json::Map::new();
      for input in descriptor["inputs"].as_array().unwrap() {
        let value = match input["target"].as_str().unwrap() {
          "WorkspaceName" => json!({"kind":"text","value":name}),
          "InitialContent" | "AssistanceMode" => {
            let native = if input["target"] == "InitialContent" { "empty" } else { "guided" };
            let choice = input["choices"].as_array().unwrap().iter().find(|choice| choice["value"]["choice"] == native || choice["value"]["text"] == native).unwrap();
            json!({"kind":"choice","value":choice["id"]})
          }
          other => panic!("unsupported Empty allocation target {other}"),
        };
        answers.insert(input["id"].as_str().unwrap().to_string(), value);
      }
      let answers = serde_json::Value::Object(answers);
      let before: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE created_by_user_id=$1")
        .bind(user).fetch_one(&pool).await.unwrap();
      let prepare = helpers::gql(&app, session, json!({
        "query":"query($input:PrepareWorkspaceAssistantInput!){currentUser{prepareWorkspaceAssistant(input:$input){package{id version digest} planDigest name initialContent assistanceMode}}}",
        "variables":{"input":{"identity":identity_json,"answers":answers}}
      })).await;
      assert!(prepare.get("errors").is_none(), "{prepare}");
      let prepared = &prepare["data"]["currentUser"]["prepareWorkspaceAssistant"];
      let after: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE created_by_user_id=$1")
        .bind(user).fetch_one(&pool).await.unwrap();
      assert_eq!(after, before, "readonly preparation allocated a Workspace");
      assert_eq!(prepared["initialContent"], "Empty");
      let request_id = Uuid::new_v4();
      let mut input = json!({"name":name,"initialContent":"Empty","assistanceMode":"Guided","requestId":request_id,
        "assistantConfirmation":{"identity":identity_json,"answers":answers,"planDigest":prepared["planDigest"]}});
      let create = "mutation($input:CreateWorkspaceInput!){createWorkspace(input:$input){id name initialContentPolicy creation{requestId status rootReady tasksReady tasksDatabaseId assistanceSaved retryRequired reasonCode}}}";
      let mut invalid = input.clone();
      invalid["assistantConfirmation"]["planDigest"] = json!("0".repeat(64));
      let rejected = helpers::gql(&app, session, json!({"query":create,"variables":{"input":invalid}})).await;
      assert!(rejected.get("errors").is_some(), "invalid confirmation accepted: {rejected}");
      let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces WHERE created_by_user_id=$1").bind(user).fetch_one(&pool).await.unwrap();
      assert_eq!(count,before,"rejected confirmation allocated content");

      // Simulate cookies switching to Bob after Alice's successful prepare,
      // while the client still holds Alice's exact confirmed input.
      let other_before: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1),(SELECT count(*) FROM user_preferences WHERE user_id=$1)")
        .bind(other).fetch_one(&pool).await.unwrap();
      let other_preferences = auth_store.get_user_preferences(other).await.unwrap();
      let switched = helpers::gql(&app, other_session, json!({"query":create,"variables":{"input":input}})).await;
      if let Some(unexpected) = switched["data"]["createWorkspace"]["id"].as_str() {
        owned_workspaces.push(unexpected.parse().expect("unexpected allocation identity"));
      }
      assert_eq!(switched["errors"][0]["extensions"]["name"],"INVALID_INPUT","another actor must not apply Alice's plan: {switched}");
      assert_eq!(switched["errors"][0]["extensions"]["code"],"BAD REQUEST");
      assert_eq!(switched["errors"][0]["extensions"]["type"],"BAD_REQUEST");
      let other_after: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1),(SELECT count(*) FROM user_preferences WHERE user_id=$1)")
        .bind(other).fetch_one(&pool).await.unwrap();
      assert_eq!(other_after,other_before,"actor mismatch must reject before Workspace, receipt or preference writes");
      assert_eq!(auth_store.get_user_preferences(other).await.unwrap(),other_preferences);

      let first = helpers::gql(&app, session, json!({"query":create,"variables":{"input":input}}));
      let second = helpers::gql(&app, session, json!({"query":create,"variables":{"input":input}}));
      let (first, second) = tokio::join!(first, second);
      for result in [&first, &second] { assert!(result.get("errors").is_none(), "{result}"); }
      let result = &first["data"]["createWorkspace"];
      assert_eq!(result["id"], second["data"]["createWorkspace"]["id"]);
      let workspace: Uuid = result["id"].as_str().unwrap().parse().unwrap();
      owned_workspaces.push(workspace);
      assert_eq!(result["initialContentPolicy"], "Empty");
      assert_eq!(result["creation"]["status"], "Ready");
      assert_eq!(result["creation"]["rootReady"], true);
      assert_eq!(result["creation"]["tasksReady"], true);
      assert_eq!(result["creation"]["assistanceSaved"], true);
      assert_eq!(result["creation"]["retryRequired"], false);
      let counts: (i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM docs WHERE workspace_id=$1),(SELECT count(*) FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'),(SELECT count(*) FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id WHERE d.workspace_id=$1),(SELECT count(*) FROM workspace_template_policies WHERE workspace_id=$1)")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(counts, (1,1,0,0), "Empty must contain only its technical root and empty native Tasks");
      let native_root: Vec<u8> = sqlx::query_scalar("SELECT payload FROM doc_updates WHERE workspace_id=$1 AND doc_id=$1 AND sequence=1")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      let root_metadata = yjs::extract_workspace_root_metadata(&native_root).unwrap();
      assert_eq!(root_metadata.name.as_deref(), Some(name.as_str()));
      assert!(root_metadata.pages.is_empty());
      let metadata = helpers::gql(&app, session, json!({"query":"query($id:String!){workspace(id:$id){id initialContentPolicy} workspaces{id initialContentPolicy}}","variables":{"id":workspace}})).await;
      assert!(metadata.get("errors").is_none(), "{metadata}");
      assert_eq!(metadata["data"]["workspace"]["initialContentPolicy"], "Empty");
      assert_eq!(metadata["data"]["workspaces"].as_array().unwrap().iter().find(|entry| entry["id"] == workspace.to_string()).unwrap()["initialContentPolicy"], "Empty");
      let registry = state.template_registry().unwrap();
      assert_eq!(registry.seed_default_policies_for_workspace(workspace).await.unwrap(), 0);
      assert!(registry.query_builtin_reconcile_slugs(workspace, "en").await.unwrap().is_empty());
      assert!(registry.reconcile_workspace_templates(workspace).await.unwrap().is_empty());
      let docs_after: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(docs_after, 1);
      assert!(sqlx::query("UPDATE workspaces SET initial_content_policy='legacy_defaults' WHERE id=$1").bind(workspace).execute(&pool).await.is_err());

      // A saved receipt is an acknowledgement, not a command to restore an old mode.
      let changed = helpers::gql(&app, session, json!({"query":"mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{workspaceAssistanceOverrides{workspaceId mode}}}}","variables":{"input":{"workspaceAssistanceOverrides":[{"workspaceId":workspace,"mode":"Manual"}]}}})).await;
      assert!(changed.get("errors").is_none(), "{changed}");
      let native_input = WorkspaceStarterInput { setup: None, project: None, admission_confirmation: None,
        request_id, name: name.clone(), initial_content: WorkspaceInitialContent::Empty, assistance_mode: AssistanceMode::Guided,
        package: identity.clone(), answers: serde_json::from_value(answers.clone()).unwrap(), plan_digest: prepared["planDigest"].as_str().unwrap().to_string(),
      };
      // Retire creation entries while retaining their exact immutable source
      // inventory. Existing SQL owners and presentation defaults are unchanged.
      let native_templates = helpers::database_starter_catalog();
      let services = state.database_services().unwrap();
      let files = myoxus_infrastructure::assistant_packages::capture_assistant_package_files(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/assistants"),
      ).unwrap();
      let (mut package_source, definitions) = myoxus_infrastructure::assistant_packages::decode_assistant_package_sources(&files).unwrap();
      package_source.packages.retain(|entry| !definitions.iter().any(|(source, _)| source.id == entry.id
        && source.contexts.iter().any(|context| matches!(context, AssistantPackageContext::WorkspaceCreation | AssistantPackageContext::ProjectCreation))));
      let inventory = AssistantPackageInventory::from_sources(definitions, &native_templates).unwrap();
      assert!(inventory.get(&identity).is_ok(),"retirement must preserve the exact accepted source");
      let retired_catalog = AssistantPackageCatalog::from_inventory(package_source.packages, inventory).unwrap();
      assert!(retired_catalog.default_descriptor(AssistantPackageContext::WorkspaceCreation).is_none());
      let retired = Arc::new(AssistantPackageService::new(Arc::new(retired_catalog),native_templates.clone(),
        services.definition.clone(),services.views.clone(),Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(),native_templates.clone())),state.config.i18n.default_currency.clone(),state.config.i18n.default_locale.clone()));
      let retired_app = myoxus_api::build_router_for_integration_tests(state.clone().with_assistant_packages(retired.clone()));
      let project_default = native_templates.system_source(DatabaseTemplateSourceRole::ProjectDefault).unwrap();
      let template = native_templates.summaries().into_iter().find(|summary| summary.profile_kind == DatabaseProfileKind::Project && summary.id != project_default.template_id).unwrap();
      let active = state.assistant_packages().unwrap();
      let project_package = active.list(AssistantPackageContext::ProjectCreation).into_iter().find(|descriptor| descriptor.components.iter()
        .any(|component| matches!(&component.action, AssistantNativeAction::CreateProject {template_id,..} if *template_id == template.id))).unwrap();
      let project_answers = project_package.inputs.iter().filter_map(|input| {
        let answer = match input.target {
          AssistantInputTarget::Title => Some(AssistantValue::Text("Explicit active Project".into())),
          AssistantInputTarget::Description => Some(AssistantValue::Text("A native Project survives offering retirement.".into())),
          AssistantInputTarget::IncludeSamples => Some(AssistantValue::Boolean(true)),
          AssistantInputTarget::IncludeScaffold => Some(AssistantValue::Boolean(false)),
          _ => input.default.clone(),
        };
        answer.map(|value| (input.id.clone(),value))
      }).collect();
      let project_plan = active.prepare_project(user,workspace,&project_package.identity,project_answers,"en",None).await.unwrap();
      let before_retired: (i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1),(SELECT count(*) FROM workspace_databases WHERE workspace_id=$2),(SELECT count(*) FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id WHERE d.workspace_id=$2)")
        .bind(user).bind(workspace).fetch_one(&pool).await.unwrap();
      let preferences_before_retired = auth_store.get_user_preferences(user).await.unwrap();
      let rejected_workspace_prepare = retired.prepare_workspace(&identity,native_input.answers.clone()).unwrap_err();
      assert!(rejected_workspace_prepare.contains("not an active current offering"),"{rejected_workspace_prepare}");
      let rejected_project_prepare = retired.prepare_project(user,workspace,&project_plan.package,project_plan.answers.clone(),"en",None).await.unwrap_err();
      assert_eq!(rejected_project_prepare.code,"MIX_ASSISTANT_PACKAGE_INVALID");
      assert!(rejected_project_prepare.message.contains("not an active current offering"));
      let rejected_apply = match retired.apply_project(user,workspace,project_plan.clone()).await {
        Ok(_) => panic!("retired unaccepted Project plan applied"),
        Err(error) => error,
      };
      assert_eq!(rejected_apply.code,"MIX_ASSISTANT_PACKAGE_INVALID");
      assert!(rejected_apply.message.contains("not an active current offering"));
      let mut fresh_retired = input.clone();
      fresh_retired["requestId"] = json!(Uuid::new_v4());
      let rejected_allocation = helpers::gql(&retired_app,session,json!({"query":create,"variables":{"input":fresh_retired}})).await;
      if let Some(unexpected) = rejected_allocation["data"]["createWorkspace"]["id"].as_str() {
        owned_workspaces.push(unexpected.parse().expect("unexpected retired allocation"));
      }
      assert_eq!(rejected_allocation["errors"][0]["extensions"]["name"],"INVALID_INPUT","{rejected_allocation}");
      let after_retired: (i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1),(SELECT count(*) FROM workspace_databases WHERE workspace_id=$2),(SELECT count(*) FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id WHERE d.workspace_id=$2)")
        .bind(user).bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(after_retired,before_retired,"retired fresh actions wrote allocation, receipt, Database or Rows");
      assert_eq!(auth_store.get_user_preferences(user).await.unwrap(),preferences_before_retired);
      let created_project = active.apply_project(user,workspace,project_plan.clone()).await.unwrap();
      assert_eq!(created_project.record.database.workspace_id,workspace);
      assert_eq!(created_project.record.database.profile_kind,DatabaseProfileKind::Project);

      // Starter retirement also leaves the installed managed current target
      // admitted. Only a new ordinary creation request loses eligibility.
      let files = myoxus_infrastructure::database_templates::capture_database_template_files(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      ).unwrap();
      let (mut source, definitions, updates) = myoxus_infrastructure::database_templates::decode_database_template_sources(&files).unwrap();
      source.templates.iter_mut().find(|entry| entry.id == project_plan.template_id).unwrap().offering = Some(false);
      let retired_templates = Arc::new(myoxus_application::database::DatabaseStarterTemplateCatalog::from_sources(source,definitions,updates).unwrap());
      let repository = Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(),retired_templates.clone()));
      let definition = myoxus_application::database::DatabaseDefinitionService::new(repository.clone(),repository.clone(),state.permission_service(),
        myoxus_application::database::DatabaseLimits::default(),services.effects.clone(),retired_templates.clone(),services.projection.clone());
      let before_create: (i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspace_databases WHERE workspace_id=$1),(SELECT count(*) FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id WHERE d.workspace_id=$1)")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      let denied = definition.create_database_from_template(user,myoxus_application::database::CreateDatabaseFromTemplate {
        workspace_id:workspace,template_id:project_plan.template_id.clone(),title:"Retired direct starter".into(),description:None,
        include_sample_rows:true,priority_preset:project_plan.priority,complexity_preset:project_plan.complexity,
        structure_preset:project_plan.structure,default_currency:project_plan.default_currency.clone(),
      }).await.unwrap_err();
      assert_eq!(denied.code,"MIX_DATABASE_NOT_FOUND");
      let after_create: (i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspace_databases WHERE workspace_id=$1),(SELECT count(*) FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id WHERE d.workspace_id=$1)")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(after_create,before_create,"retired starter allocated native contents");
      let project_id = created_project.record.database.id;
      let before_verify = repository.get_database_for_lifecycle(project_id).await.unwrap().unwrap();
      let contents_query = "SELECT jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM workspace_database_rows r WHERE r.database_id=$1),'cells',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.row_id,c.field_id),'[]'::jsonb) FROM workspace_database_cell_values c JOIN workspace_database_rows r ON r.id=c.row_id WHERE r.database_id=$1),'templates',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM workspace_database_row_templates t WHERE t.database_id=$1))";
      let contents_before:serde_json::Value = sqlx::query_scalar(contents_query).bind(project_id).fetch_one(&pool).await.unwrap();
      assert!(!contents_before["rows"].as_array().unwrap().is_empty(),"retirement fixture needs actual native sample Rows");
      assert!(!contents_before["cells"].as_array().unwrap().is_empty());
      assert!(!contents_before["templates"].as_array().unwrap().is_empty());
      let notifications = ManagedUpdateNotifications::default();
      let outcome = myoxus_application::database::definition::managed_schema::reconcile_managed_database(&retired_templates,repository.as_ref(),project_id,&notifications,services.projection.as_ref()).await.unwrap();
      assert!(outcome.ready,"creation retirement made an installed Project unavailable");
      assert_eq!(notifications.0.load(std::sync::atomic::Ordering::SeqCst),0,"retirement emitted a spurious managed update");
      let after_verify = repository.get_database_for_lifecycle(project_id).await.unwrap().unwrap();
      assert_eq!(serde_json::to_value(after_verify).unwrap(),serde_json::to_value(before_verify).unwrap());
      let contents_after:serde_json::Value = sqlx::query_scalar(contents_query).bind(project_id).fetch_one(&pool).await.unwrap();
      assert_eq!(contents_after,contents_before,"retirement verification changed persisted Rows, Cells or Row templates");
      let retained_replay = state.workspace().create_workspace_starter(user,native_input.clone(),Some(retired.as_ref()),state.auth()).await.unwrap();
      assert_eq!(retained_replay.allocation.workspace.id,workspace);
      assert!(retained_replay.allocation.receipt.assistance_saved);

      let retained_api_replay = helpers::gql(&retired_app,session,json!({"query":create,"variables":{"input":input}})).await;
      assert!(retained_api_replay.get("errors").is_none(),"accepted API readback must precede the retired-source fence: {retained_api_replay}");
      assert_eq!(retained_api_replay["data"]["createWorkspace"]["id"],workspace.to_string());
      let replay = state.workspace().create_workspace_starter(user, native_input.clone(), None, state.auth()).await.unwrap();
      assert_eq!(replay.allocation.workspace.id, workspace, "accepted replay needs no current package source");
      assert!(replay.allocation.receipt.assistance_saved);
      assert_eq!(state.auth().get_assistance(user, Some(workspace), None).await.unwrap().mode, AssistanceMode::Manual);
      let accepted_input = input.clone();
      input["assistantConfirmation"]["identity"]["digest"] = json!("f".repeat(64));
      let conflict = helpers::gql(&app, session, json!({"query":create,"variables":{"input":input}})).await;
      assert_eq!(conflict["errors"][0]["extensions"]["code"], "XWS_WORKSPACE_STARTER_CONFLICT", "{conflict}");
      let receipt_count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1 AND request_id=$2")
        .bind(user).bind(request_id).fetch_one(&pool).await.unwrap();
      assert_eq!(receipt_count, 1);

      // Allocation survives a denied preference acknowledgement. Restoring current
      // membership resumes the same accepted request, not another Workspace.
      let pending_request = Uuid::new_v4();
      let pending_workspace = Uuid::new_v4();
      let pending_name = format!("Pending {}", pending_request);
      let mut pending_input = native_input.clone();
      pending_input.request_id = pending_request;
      pending_input.name = pending_name.clone();
      let name_key = descriptor["inputs"].as_array().unwrap().iter().find(|input| input["target"]=="WorkspaceName").unwrap()["id"].as_str().unwrap();
      pending_input.answers.insert(name_key.into(),myoxus_domain::assistant_package::AssistantValue::Text(pending_name.clone()));
      pending_input.plan_digest = state.assistant_packages().unwrap().prepare_workspace(&pending_input.package,pending_input.answers.clone()).unwrap().plan_digest(user);

      let store = myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(), helpers::database_starter_catalog());

      // The receipt CHECK runs after native root and Tasks insertion. A late
      // failure must roll back every identity, not leave a published partial kit.
      let fault_workspace = Uuid::new_v4();
      let fault_request = Uuid::new_v4();
      let fault_name = format!("Late rollback {}",fault_workspace);
      owned_workspaces.push(fault_workspace);
      let late_error = store.allocate_workspace_starter(WorkspaceStarterReceipt { prepared: None, setup_definition: None,
        actor_id:user,request_id:fault_request,fingerprint:"not-sha256".into(),package:identity.clone(),
        workspace_id:fault_workspace,name:fault_name.clone(),assistance_mode:AssistanceMode::Guided,assistance_saved:false,
      },yjs::create_initial_workspace_doc(&fault_name)).await.unwrap_err();
      assert!(matches!(&late_error,myoxus_application::workspace::WorkspaceStarterError::Auth(myoxus_application::auth::AuthError::Storage(message))
        if message.contains("workspace_starter_applications_fingerprint_check")),"expected the late receipt CHECK failure: {late_error:?}");
      let rolled_back: (i64,i64,i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE id=$1),(SELECT count(*) FROM docs WHERE workspace_id=$1 OR id=$1),(SELECT count(*) FROM doc_updates WHERE workspace_id=$1),(SELECT count(*) FROM workspace_memberships WHERE workspace_id=$1),(SELECT count(*) FROM workspace_databases WHERE workspace_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE workspace_id=$1 OR (actor_id=$2 AND request_id=$3))")
        .bind(fault_workspace).bind(user).bind(fault_request).fetch_one(&pool).await.unwrap();
      assert_eq!(rolled_back,(0,0,0,0,0,0),"late receipt failure left Workspace/root/content/membership/Tasks/receipt state");

      store.allocate_workspace_starter(WorkspaceStarterReceipt { prepared: None, setup_definition: None,
        actor_id:user,request_id:pending_request,fingerprint:pending_input.fingerprint(),package:identity,
        workspace_id:pending_workspace,name:pending_name.clone(),assistance_mode:AssistanceMode::Guided,assistance_saved:false,
      }, yjs::create_initial_workspace_doc(&pending_name)).await.unwrap();
      owned_workspaces.push(pending_workspace);
      sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(pending_workspace).bind(user).execute(&pool).await.unwrap();
      let prefs_before = auth_store.get_user_preferences(user).await.unwrap();
      assert!(auth_store.acknowledge_workspace_starter_assistance(user,pending_request).await.is_err());
      assert_eq!(auth_store.get_user_preferences(user).await.unwrap(), prefs_before);
      let pending: bool = sqlx::query_scalar("SELECT assistance_saved_at IS NULL FROM workspace_starter_applications WHERE actor_id=$1 AND request_id=$2")
        .bind(user).bind(pending_request).fetch_one(&pool).await.unwrap();
      assert!(pending);
      helpers::add_workspace_member(&pool,pending_workspace,user).await;
      let resumed = state.workspace().create_workspace_starter(user,pending_input,None,state.auth()).await.unwrap();
      assert_eq!(resumed.allocation.workspace.id,pending_workspace);
      assert!(resumed.allocation.receipt.assistance_saved);

      // Explicit document creation remains permitted; Empty is not a content ACL.
      helpers::create_doc(&pool,workspace,user).await;
      let before_delete: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(before_delete,2);
      helpers::cleanup_workspaces(&pool,&[workspace]).await;
      let gone_before: (i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1)").bind(user).fetch_one(&pool).await.unwrap();
      let gone = state.workspace().create_workspace_starter(user,native_input,Some(retired.as_ref()),state.auth()).await.unwrap_err();
      assert!(matches!(gone,myoxus_application::workspace::WorkspaceStarterError::Gone{workspace_id} if workspace_id==workspace));
      let gone_api = helpers::gql(&retired_app,session,json!({"query":create,"variables":{"input":accepted_input}})).await;
      assert_eq!(gone_api["errors"][0]["extensions"]["code"],"XWS_WORKSPACE_STARTER_GONE","{gone_api}");
      let gone_after: (i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1)").bind(user).fetch_one(&pool).await.unwrap();
      assert_eq!(gone_after,gone_before,"retired accepted Gone replay allocated a replacement");
      let changed_gone = helpers::gql(&app, session, json!({"query":create,"variables":{"input":input}})).await;
      assert_eq!(changed_gone["errors"][0]["extensions"]["code"], "XWS_WORKSPACE_STARTER_CONFLICT", "changed accepted input must conflict even after target deletion: {changed_gone}");

      let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1 AND request_id=$2").bind(user).bind(request_id).fetch_one(&pool).await.unwrap();
      assert_eq!(remaining,1,"target deletion must retain the accepted key");
      auth_store.commit_user_deletion(user).await.unwrap();
      let private_receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1").bind(user).fetch_one(&pool).await.unwrap();
      assert_eq!(private_receipts,0,"operational account deletion must remove private starter receipts despite retained identity");
    }).catch_unwind().await;
    helpers::cleanup_workspaces(&pool, &owned_workspaces).await;
    helpers::cleanup_users(&pool, &[user, other]).await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}

#[test]
fn feature_artwork_http_revalidates_actor_and_retained_workspace_acceptance() {
  helpers::block_on_large_stack("feature-artwork-authorization", || async {
    use axum::{
      body::Body,
      http::{Request, StatusCode, header},
    };
    use futures_util::FutureExt;
    use http_body_util::BodyExt;
    use myoxus_application::feature_bundle::assemble_feature_catalogs;
    use myoxus_application::workspace::WorkspaceStarterInput;
    use myoxus_domain::{assistant_package::*, feature_bundle::*};
    use myoxus_infrastructure::feature_bundles::{
      CapturedFeatureSourceSet, pack_captured_feature_bundle, read_feature_bundle,
    };
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, sync::Arc};
    use tower::ServiceExt;

    async fn get(app: &axum::Router, url: &str, session: Option<Uuid>, etag: Option<&str>) -> axum::response::Response {
      let mut request = Request::builder().uri(url);
      if let Some(session) = session {
        request = request.header(header::COOKIE, format!("affine_session={session}"));
      }
      if let Some(etag) = etag {
        request = request.header(header::IF_NONE_MATCH, etag);
      }
      app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap()
    }
    fn url(pin: &FeatureBundlePin, component: &str) -> String {
      format!(
        "/api/templates/features/{}/{}/{}/{}",
        pin.id, pin.version, pin.sha256, component
      )
    }

    let (_, pool, auth_store, state) = helpers::setup_app_with_state().await;
    let (actor, session) = helpers::seed_user(&pool, &auth_store, "feature-artwork-owner").await;
    let (other, other_session) = helpers::seed_user(&pool, &auth_store, "feature-artwork-other").await;
    let mut owned_workspaces = Vec::new();
    let outcome = std::panic::AssertUnwindSafe(async {
      let shipped = helpers::feature_source_set();
      let mut source_a = shipped.bundles.iter().find(|bundle| bundle.pin() == shipped.release.base).unwrap().clone();
      let descriptor = shipped.resolved.assistants.default_descriptor(AssistantPackageContext::WorkspaceCreation).unwrap();
      let (assistant_component, sources) = source_a.assistants.iter().find(|(_, sources)| sources.definitions.iter().any(|(package, digest)| package.id == descriptor.identity.id && package.version == descriptor.identity.version && *digest == descriptor.identity.digest)).unwrap();
      let package = &sources.definitions.iter().find(|(package, _)| package.id == descriptor.identity.id && package.version == descriptor.identity.version).unwrap().0;
      let step = &package.presentation.steps[0];
      let group = &step.groups[0];
      assert!(group.visible_when.is_none());
      let artwork = source_a.manifest.components.iter().find(|component| component.kind == FeatureComponentKind::Artwork && component.artwork.as_ref().unwrap().media_type == "image/svg+xml").unwrap().clone();
      // The shipped introduction now has its own illustration. Replace that
      // slot's link for this SVG authorization fixture, rather than declaring
      // two competing assets for the same native presentation slot.
      let artwork_export = format!("{}@{}", package.id, package.version);
      let artwork_key = format!("group/{}/{}", step.id, group.id);
      source_a.manifest.links.retain(|link| !matches!(link, FeatureLink::Artwork { from, .. }
        if from.component == *assistant_component && from.export == artwork_export && from.key.as_deref() == Some(artwork_key.as_str())));
      source_a.manifest.links.push(FeatureLink::Artwork {
        from: FeatureNativeReference { component: assistant_component.clone(), export: artwork_export, key: Some(artwork_key) },
        to: FeatureReference::Local { reference: FeatureNativeReference { component: artwork.id.clone(), export: artwork.id.clone(), key: None } },
      });
      // Both fixtures cross the real closed archive boundary. Selection metadata
      // and Artwork change; retained native definition bodies remain immutable.
      let a_bytes = pack_captured_feature_bundle(&source_a.manifest, &source_a.files).unwrap();
      let a = read_feature_bundle(&a_bytes).unwrap();
      let mut b_manifest = a.manifest.clone();
      let a_version = semver::Version::parse(&a.manifest.version).expect("captured base semver");
      b_manifest.version = semver::Version::new(
        a_version.major,
        a_version.minor,
        a_version.patch.checked_add(1).expect("fixture successor patch fits semver"),
      ).to_string();
      let mut b_files = a.files.clone();
      let mut b_artwork = String::from_utf8(b_files[&artwork.path].clone()).unwrap();
      assert!(b_artwork.contains("</svg>"));
      b_artwork = b_artwork.replace("</svg>", "<!-- immutable wrapper B artwork -->\n</svg>");
      b_files.insert(artwork.path.clone(), b_artwork.into_bytes());
      let b_digest = format!("{:x}", Sha256::digest(&b_files[&artwork.path]));
      b_manifest.files.insert(artwork.path.clone(), b_digest.clone());
      b_manifest.components.iter_mut().find(|component| component.id == artwork.id).unwrap().sha256 = b_digest.clone();
      let project_packages = shipped.resolved.assistants.list(AssistantPackageContext::ProjectCreation);
      let retired_package = project_packages.iter().find(|package| !package.default_for.contains(&AssistantPackageContext::ProjectCreation)).unwrap().clone();
      let replacement_default = project_packages.iter().find(|package| package.identity != retired_package.identity && !package.default_for.contains(&AssistantPackageContext::ProjectCreation)).unwrap().clone();
      let retired_template = retired_package.components.iter().find_map(|component| match &component.action {
        AssistantNativeAction::CreateProject { template_id, .. } => Some(template_id.clone()), _ => None,
      }).unwrap();
      let mut database_selection = a.databases["databases"].catalog.clone();
      database_selection.templates.iter_mut().find(|entry| entry.id == retired_template).unwrap().offering = Some(false);
      let mut assistant_selection = a.assistants[assistant_component].catalog.clone();
      let removed = assistant_selection.packages.iter().find(|entry| entry.id == retired_package.identity.id).unwrap().clone();
      assistant_selection.packages.retain(|entry| entry.id != removed.id);
      for entry in &mut assistant_selection.packages {
        entry.default_for.retain(|context| *context != AssistantPackageContext::ProjectCreation);
        if entry.id == replacement_default.identity.id { entry.default_for.push(AssistantPackageContext::ProjectCreation); }
      }
      let database_catalog_path = a.manifest.components.iter().find(|component| component.id == "databases").unwrap().path.clone();
      let assistant_catalog_path = a.manifest.components.iter().find(|component| component.id == *assistant_component).unwrap().path.clone();
      let removed_paths: Vec<_> = removed.definitions.iter().map(|reference| format!("{}{}", assistant_catalog_path.strip_suffix("catalog.yaml").unwrap(), reference.path)).collect();
      for path in &removed_paths { b_files.remove(path); b_manifest.files.remove(path); }
      b_files.insert(database_catalog_path.clone(), myoxus_contracts::config_document::encode_config_yaml(&database_selection).unwrap().into_bytes());
      b_files.insert(assistant_catalog_path.clone(), myoxus_contracts::config_document::encode_config_yaml(&assistant_selection).unwrap().into_bytes());
      b_manifest.exports.retain(|export| !(export.source.component == *assistant_component && export.source.export == format!("{}@{}", removed.id, removed.current))
        && !(export.source.component == "databases" && export.source.export.starts_with(&format!("{retired_template}@"))));
      b_manifest.links.retain(|link| {
        let from = match link {
          FeatureLink::Workflow { from, .. }
          | FeatureLink::TaskCore { from, .. }
          | FeatureLink::Schema { from, .. }
          | FeatureLink::View { from, .. }
          | FeatureLink::DocumentSource { from, .. }
          | FeatureLink::DocumentComponent { from, .. }
          | FeatureLink::Artwork { from, .. }
          | FeatureLink::Input { from, .. }
          | FeatureLink::Context { from, .. }
          | FeatureLink::PriorResult { from, .. } => from,
        };
        !(from.component == *assistant_component && from.export.starts_with(&format!("{}@", removed.id)))
      });
      for path in [&database_catalog_path, &assistant_catalog_path] {
        let digest = format!("{:x}", Sha256::digest(&b_files[path]));
        b_manifest.files.insert(path.clone(), digest.clone());
        b_manifest.components.iter_mut().find(|component| component.path == *path).unwrap().sha256 = digest;
      }
      let b_bytes = pack_captured_feature_bundle(&b_manifest, &b_files).unwrap();
      let b = read_feature_bundle(&b_bytes).unwrap();
      assert_ne!(a.pin(), b.pin());
      for (path, bytes) in a.files.iter().filter(|(path, _)| path.as_str() != artwork.path && path.as_str() != database_catalog_path && path.as_str() != assistant_catalog_path && !removed_paths.contains(path)) {
        assert_eq!(bytes, &b.files[path], "wrapper B must preserve every retained native child byte");
      }
      for component in a.manifest.components.iter().filter(|component| !matches!(component.kind, FeatureComponentKind::Artwork | FeatureComponentKind::DatabaseCatalog | FeatureComponentKind::AssistantCatalog)) {
        let next = b.manifest.components.iter().find(|next| next.id == component.id).unwrap();
        assert_eq!(component.sha256, next.sha256);
        assert_eq!(a.files[&component.path], b.files[&component.path]);
        assert_eq!(component.native_identity, next.native_identity);
      }
      let release = FeatureReleaseDescriptor { format_version: 1, base: b.pin() };
      let catalog = FeatureBundleCatalogSource { format_version: 1, base: b.pin(), optional: vec![], retained: vec![a.pin()] };
      let bundles = vec![a.clone(), b.clone()];
      let resolved = assemble_feature_catalogs(&release, &catalog, &bundles).unwrap();
      assert_eq!(resolved.assistants.default_descriptor(AssistantPackageContext::ProjectCreation).unwrap().identity, replacement_default.identity);
      assert!(!resolved.assistants.list(AssistantPackageContext::ProjectCreation).iter().any(|package| package.identity == retired_package.identity));
      assert!(!resolved.databases.summaries().iter().any(|template| template.id == retired_template));
      assert!(resolved.databases.current_source(&retired_template).is_some());
      let b_templates = Arc::new(resolved.databases.clone());
      let b_packages = Arc::new(resolved.assistants.clone());
      let app = myoxus_api::build_router_for_integration_tests(state.clone().with_feature_sources(Arc::new(CapturedFeatureSourceSet { release, catalog, bundles, resolved })));
      let old_url = url(&a.pin(), &artwork.id);
      let current_url = url(&b.pin(), &artwork.id);
      let old_etag = format!("\"{}\"", artwork.sha256);
      let current_etag = format!("\"{b_digest}\"");

      for conditional in [None, Some("*"), Some(current_etag.as_str())] {
        let denied = get(&app, &current_url, None, conditional).await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(denied.headers()[header::CACHE_CONTROL], "private, no-store");
        assert_eq!(get(&app, &current_url, Some(Uuid::new_v4()), conditional).await.status(), StatusCode::UNAUTHORIZED);
      }
      let response = get(&app, &current_url, Some(session), None).await;
      assert_eq!(response.status(), StatusCode::OK);
      assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
      assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
      assert_eq!(response.headers()[header::CONTENT_SECURITY_POLICY], "sandbox allow-downloads");
      assert_eq!(response.headers()[header::CACHE_CONTROL], "private, no-cache");
      assert_eq!(response.headers()[header::VARY], "Cookie");
      assert_eq!(response.headers()[header::ETAG], current_etag);
      assert_eq!(response.into_body().collect().await.unwrap().to_bytes().as_ref(), b.files[&artwork.path].as_slice());
      let unchanged = get(&app, &current_url, Some(session), Some(&current_etag)).await;
      assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
      assert!(unchanged.into_body().collect().await.unwrap().to_bytes().is_empty());
      assert_eq!(get(&app, &current_url, Some(other_session), None).await.status(), StatusCode::OK, "active declared artwork needs a current actor, not Workspace membership");
      let mut wrong_pin = b.pin(); wrong_pin.sha256 = "0".repeat(64);
      let mut wrong_version = b.pin(); wrong_version.version = "9.9.9".into();
      let mut wrong_provider = b.pin(); wrong_provider.id = "unknown-provider".into();
      for missing in [url(&wrong_pin, &artwork.id), url(&wrong_version, &artwork.id), url(&wrong_provider, &artwork.id), url(&b.pin(), "undeclared-artwork"), url(&b.pin(), assistant_component)] {
        let absent = get(&app, &missing, Some(session), Some("*")).await;
        assert_eq!(absent.status(), StatusCode::NOT_FOUND);
        assert_eq!(absent.headers()[header::CACHE_CONTROL], "private, no-store");
      }
      for conditional in [None, Some("*"), Some(old_etag.as_str())] {
        assert_eq!(get(&app, &old_url, None, conditional).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(get(&app, &old_url, Some(session), conditional).await.status(), StatusCode::NOT_FOUND, "retained bytes require a persisted receipt even for conditional requests");
      }

      let service = state.assistant_packages().unwrap();
      let mut answers = BTreeMap::new();
      for input in &descriptor.inputs {
        let value = match input.target {
          AssistantInputTarget::WorkspaceName => AssistantValue::Text(format!("Asset receipt {}", Uuid::new_v4())),
          AssistantInputTarget::InitialContent | AssistantInputTarget::AssistanceMode => {
            let native = if input.target == AssistantInputTarget::InitialContent { "empty" } else { "guided" };
            let choice = input.choices.iter().find(|choice| matches!(&choice.value, AssistantValue::Choice(value) | AssistantValue::Text(value) if value == native)).unwrap();
            AssistantValue::Choice(choice.id.clone())
          },
          _ => panic!("unexpected native Workspace input"),
        };
        answers.insert(input.id.clone(), value);
      }
      let prepared = service.prepare_workspace(&descriptor.identity, answers).unwrap();
      let request = WorkspaceStarterInput { setup: None, project: None, admission_confirmation: None, request_id: Uuid::new_v4(), name: prepared.name.clone(), initial_content: prepared.initial_content, assistance_mode: prepared.assistance_mode, package: prepared.package.clone(), answers: prepared.answers.clone(), plan_digest: prepared.plan_digest(actor) };
      let accepted = state.workspace().create_workspace_starter(actor, request.clone(), Some(service.as_ref()), state.auth()).await.unwrap();
      let workspace = accepted.allocation.workspace.id;
      owned_workspaces.push(workspace);
      assert!(accepted.allocation.receipt.assistance_saved);
      let receipt: (String, String, String) = sqlx::query_as("SELECT package_id,package_version,package_digest FROM workspace_starter_applications WHERE actor_id=$1 AND request_id=$2")
        .bind(actor).bind(request.request_id).fetch_one(&pool).await.unwrap();
      assert_eq!(receipt, (descriptor.identity.id.clone(), descriptor.identity.version.clone(), descriptor.identity.digest.clone()));
      let services = state.database_services().unwrap();
      let project_answers = retired_package.inputs.iter().filter_map(|input| {
        let value = match input.target {
          AssistantInputTarget::Title => Some(AssistantValue::Text("Before release B".into())),
          AssistantInputTarget::Description => Some(AssistantValue::Text("Existing Project survives offering retirement".into())),
          AssistantInputTarget::IncludeSamples => Some(AssistantValue::Boolean(true)),
          AssistantInputTarget::IncludeScaffold => Some(AssistantValue::Boolean(false)),
          _ => input.default.clone(),
        };
        value.map(|value| (input.id.clone(), value))
      }).collect();
      let old_plan = service.prepare_project(actor,workspace,&retired_package.identity,project_answers,"en",None).await.unwrap();
      let existing = service.apply_project(actor,workspace,old_plan.clone()).await.unwrap().record.database.id;
      let repository = Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(),b_templates.clone()));
      let definition = Arc::new(myoxus_application::database::DatabaseDefinitionService::new(repository.clone(),repository.clone(),state.permission_service(),
        myoxus_application::database::DatabaseLimits::default(),services.effects.clone(),b_templates.clone(),services.projection.clone()));
      let current_service = myoxus_application::workspace::assistant_packages::AssistantPackageService::new(b_packages,b_templates.clone(),definition.clone(),services.views.clone(),Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(),b_templates.clone())),state.config.i18n.default_currency.clone(),state.config.i18n.default_locale.clone());
      let counts_query = "SELECT (SELECT count(*) FROM workspace_databases WHERE workspace_id=$1),(SELECT count(*) FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id WHERE d.workspace_id=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$2)";
      let before_denied: (i64,i64,i64) = sqlx::query_as(counts_query).bind(workspace).bind(actor).fetch_one(&pool).await.unwrap();
      let denied_prepare = current_service.prepare_project(actor,workspace,&old_plan.package,old_plan.answers.clone(),"en",None).await.unwrap_err();
      assert_eq!(denied_prepare.code,"MIX_ASSISTANT_PACKAGE_INVALID");
      let denied_apply = match current_service.apply_project(actor,workspace,old_plan.clone()).await { Ok(_) => panic!("retired A plan applied under release B"), Err(error) => error };
      assert_eq!(denied_apply.code,"MIX_ASSISTANT_PACKAGE_INVALID");
      let denied_direct = definition.create_database_from_template(actor,myoxus_application::database::CreateDatabaseFromTemplate {
        workspace_id:workspace,template_id:old_plan.template_id.clone(),title:"Retired direct release A starter".into(),description:None,
        include_sample_rows:true,priority_preset:old_plan.priority,complexity_preset:old_plan.complexity,
        structure_preset:old_plan.structure,default_currency:old_plan.default_currency.clone(),
      }).await.unwrap_err();
      assert_eq!(denied_direct.code,"MIX_DATABASE_NOT_FOUND");
      let after_denied: (i64,i64,i64) = sqlx::query_as(counts_query).bind(workspace).bind(actor).fetch_one(&pool).await.unwrap();
      assert_eq!(before_denied,after_denied,"release retirement must fence direct stale actions before SQL writes");
      use myoxus_domain::database::DatabaseDefinitionRepository;
      let record_before = repository.get_database_for_lifecycle(existing).await.unwrap().unwrap();
      let contents_query = "SELECT jsonb_build_object('rows',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM workspace_database_rows r WHERE r.database_id=$1),'cells',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.row_id,c.field_id) FROM workspace_database_cell_values c JOIN workspace_database_rows r ON r.id=c.row_id WHERE r.database_id=$1),'templates',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM workspace_database_row_templates t WHERE t.database_id=$1))";
      let contents_before: serde_json::Value = sqlx::query_scalar(contents_query).bind(existing).fetch_one(&pool).await.unwrap();
      assert!(!contents_before["rows"].as_array().unwrap().is_empty());
      assert!(!contents_before["cells"].as_array().unwrap().is_empty());
      let notifications = ManagedUpdateNotifications::default();
      let verified = myoxus_application::database::definition::managed_schema::reconcile_managed_database(&b_templates,repository.as_ref(),existing,&notifications,services.projection.as_ref()).await.unwrap();
      assert!(verified.ready);
      assert_eq!(notifications.0.load(std::sync::atomic::Ordering::SeqCst),0);
      let record_after = repository.get_database_for_lifecycle(existing).await.unwrap().unwrap();
      assert_eq!(serde_json::to_value(record_before).unwrap(),serde_json::to_value(record_after).unwrap());
      let contents_after: serde_json::Value = sqlx::query_scalar(contents_query).bind(existing).fetch_one(&pool).await.unwrap();
      assert_eq!(contents_before,contents_after,"Artwork/default/offering-only release changes must not alter installed contents");
      let changed_mode = helpers::gql(&app,session,json!({"query":"mutation($input:UpdateUserPreferencesInput!){updatePreferences(input:$input){values{workspaceAssistanceOverrides{workspaceId mode}}}}","variables":{"input":{"workspaceAssistanceOverrides":[{"workspaceId":workspace,"mode":"Manual"}]}}})).await;
      assert!(changed_mode.get("errors").is_none(),"{changed_mode}");
      use myoxus_application::auth::AuthStore;
      let preferences_before_replay = auth_store.get_user_preferences(actor).await.unwrap();
      let replay = state.workspace().create_workspace_starter(actor,request.clone(),Some(&current_service),state.auth()).await.unwrap();
      assert_eq!(replay.allocation.workspace.id,workspace);
      assert_eq!(replay.allocation.receipt.request_id,request.request_id);
      assert!(replay.allocation.receipt.assistance_saved);
      let after_replay: (i64,i64,i64) = sqlx::query_as(counts_query).bind(workspace).bind(actor).fetch_one(&pool).await.unwrap();
      assert_eq!(after_replay,before_denied,"accepted Empty readback must not allocate or reseed after release replacement");
      assert_eq!(auth_store.get_user_preferences(actor).await.unwrap(),preferences_before_replay,"accepted readback must not replay assistance defaults");
      let active_default = current_service.default_descriptor(AssistantPackageContext::ProjectCreation).unwrap();
      assert_eq!(active_default.identity,replacement_default.identity);
      let current_answers = active_default.inputs.iter().filter_map(|input| {
        let value = match input.target {
          AssistantInputTarget::Title => Some(AssistantValue::Text("New release B default".into())),
          AssistantInputTarget::Description => Some(AssistantValue::Text("Active current offering remains usable".into())),
          AssistantInputTarget::IncludeSamples => Some(AssistantValue::Boolean(false)),
          AssistantInputTarget::IncludeScaffold => Some(AssistantValue::Boolean(false)),
          _ => input.default.clone(),
        };
        value.map(|value| (input.id.clone(),value))
      }).collect();
      let active_plan = current_service.prepare_project(actor,workspace,&active_default.identity,current_answers,"en",None).await.unwrap();
      let active_result = current_service.apply_project(actor,workspace,active_plan).await.unwrap();
      assert_ne!(active_result.record.database.id,existing);
      assert_eq!(active_result.record.database.title,"New release B default");

      let response = get(&app, &old_url, Some(session), None).await;
      assert_eq!(response.status(), StatusCode::OK);
      assert_eq!(response.headers()[header::ETAG], old_etag);
      assert_eq!(response.headers()[header::CACHE_CONTROL], "private, no-cache");
      assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
      assert_eq!(response.headers()[header::CONTENT_SECURITY_POLICY], "sandbox allow-downloads");
      assert_eq!(response.into_body().collect().await.unwrap().to_bytes().as_ref(), a.files[&artwork.path].as_slice());
      assert_eq!(get(&app, &old_url, Some(session), Some(&old_etag)).await.status(), StatusCode::NOT_MODIFIED);
      helpers::add_workspace_member(&pool, workspace, other).await;
      for conditional in [None, Some("*"), Some(old_etag.as_str())] {
        assert_eq!(get(&app, &old_url, Some(other_session), conditional).await.status(), StatusCode::NOT_FOUND, "membership alone is not another actor's acceptance");
      }
      // Retain the immutable receipt while changing the live membership fact.
      sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(workspace).bind(actor).execute(&pool).await.unwrap();
      for conditional in [None, Some("*"), Some(old_etag.as_str())] {
        assert_eq!(get(&app, &old_url, Some(session), conditional).await.status(), StatusCode::NOT_FOUND);
      }
      helpers::add_workspace_member(&pool, workspace, actor).await;
      assert_eq!(get(&app, &old_url, Some(session), None).await.status(), StatusCode::OK);
      helpers::cleanup_workspaces(&pool, &[workspace]).await;
      let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1 AND request_id=$2").bind(actor).bind(request.request_id).fetch_one(&pool).await.unwrap();
      assert_eq!(receipts, 1, "target deletion retains the accepted request, not its live authorization");
      for conditional in [None, Some("*"), Some(old_etag.as_str())] {
        assert_eq!(get(&app, &old_url, Some(session), conditional).await.status(), StatusCode::NOT_FOUND);
      }
    }).catch_unwind().await;
    helpers::cleanup_workspaces(&pool, &owned_workspaces).await;
    helpers::cleanup_users(&pool, &[actor, other]).await;
    if let Err(error) = outcome {
      std::panic::resume_unwind(error);
    }
  });
}

#[test]
fn project_setup_native_receipt_preserves_identity_edits_stop_and_deleted_results() {
  helpers::block_on_large_stack("project-setup-native-receipt", || async {
    use futures_util::FutureExt;
    use myoxus_application::workspace::{
      ProjectStarterError, ProjectStarterInput, ProjectStarterStatus, WorkspaceStore,
    };
    use myoxus_domain::assistant_package::{AssistantInputTarget, AssistantPackageContext, AssistantValue};
    use std::collections::BTreeMap;

    let (_, pool, auth_store, state) = helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let (actor, session) = helpers::seed_user(&pool, &auth_store, "project-receipt-owner").await;
    let (foreign, _) = helpers::seed_user(&pool, &auth_store, "project-receipt-foreign").await;
    let mut owned = Vec::new();
    let outcome = std::panic::AssertUnwindSafe(async {
      let workspace = helpers::create_workspace(&pool, actor).await;
      owned.push(workspace);
      helpers::add_workspace_member(&pool, workspace, foreign).await;
      let packages = state.assistant_packages().unwrap();
      let descriptor = packages.list(AssistantPackageContext::ProjectCreation).into_iter()
        .find(|package| package.default_for.contains(&AssistantPackageContext::ProjectCreation)).unwrap();
      let title_input = descriptor.inputs.iter().find(|input| input.target == AssistantInputTarget::Title).unwrap().id.clone();
      let answers = descriptor.inputs.iter().filter_map(|input| match input.target {
        AssistantInputTarget::Title => Some((input.id.clone(), AssistantValue::Text("Explicit durable Project".into()))),
        AssistantInputTarget::Description => Some((input.id.clone(), AssistantValue::Text("Original reviewed content".into()))),
        AssistantInputTarget::People => Some((input.id.clone(), AssistantValue::Members(vec![foreign]))),
        AssistantInputTarget::IncludeSamples => Some((input.id.clone(), AssistantValue::Boolean(false))),
        AssistantInputTarget::IncludeComponent => Some((input.id.clone(), AssistantValue::Boolean(false))),
        _ => None,
      }).collect::<BTreeMap<_,_>>();
      let plan = packages.prepare_project(actor, workspace, &descriptor.identity, answers.clone(), "en", None).await.unwrap();
      let input = ProjectStarterInput {
        request_id: Uuid::new_v4(), package: descriptor.identity, answers, locale: "en".into(), client_version: None,
        plan_digest: myoxus_application::workspace::assistant_packages::plan_digest(&plan), admission_confirmation: None,
      };
      let default_before: Uuid = sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      let (first, second) = tokio::join!(
        state.workspace().create_project_starter(actor, workspace, input.clone(), &packages),
        state.workspace().create_project_starter(actor, workspace, input.clone(), &packages),
      );
      let first = first.unwrap();
      let second = second.unwrap();
      assert_eq!(first.status, ProjectStarterStatus::Ready);
      assert_eq!(second.status, ProjectStarterStatus::Ready);
      assert_eq!(first.accepted.ids.database_id, second.accepted.ids.database_id);
      let id = first.accepted.ids.database_id;
      let record = first.database.as_ref().unwrap();
      assert_eq!(record.database.id, id);
      let counts: (i64,i64,i64) = sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE system_role='workspace_tasks'),count(*) FILTER(WHERE system_role IS NULL) FROM workspace_databases WHERE workspace_id=$1")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(counts, (2,1,1), "concurrent confirmation creates one optional Project beside the existing default");
      let task_count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1 AND row_kind='task'")
        .bind(id).fetch_one(&pool).await.unwrap();
      assert_eq!(task_count, 0, "Project setup never interprets prose/scaffold as Tasks");
      let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_project' AND request_id=$2")
        .bind(actor).bind(input.request_id).fetch_one(&pool).await.unwrap();
      assert_eq!(receipts,1);
      let native = state.database_services().unwrap();
      let edited = native.definition.update_database_with_precondition(actor,id,Some("User edited Project".into()),None,Some(record.database.edit_revision),false).await.unwrap();
      let replay = state.workspace().create_project_starter(actor,workspace,input.clone(),&packages).await.unwrap();
      assert_eq!(replay.database.as_ref().unwrap().database.title,"User edited Project");
      assert_eq!(replay.database.as_ref().unwrap().database.edit_revision, edited.database.edit_revision);
      let app = myoxus_api::build_router_for_integration_tests(state.clone());
      let readback = helpers::gql(&app, session, json!({"query":"query($workspace:String!,$request:ID!){workspace(id:$workspace){projectSetup(requestId:$request){requestId status reservedDatabaseId acceptedPlan{title} database{database{id title}}}}}","variables":{"workspace":workspace,"request":input.request_id}})).await;
      assert!(readback.get("errors").is_none(),"{readback}");
      let readback = &readback["data"]["workspace"]["projectSetup"];
      assert_eq!(readback["status"], "Ready");
      assert_eq!(readback["reservedDatabaseId"], id.to_string());
      assert_eq!(readback["acceptedPlan"]["title"], "Explicit durable Project");
      assert_eq!(readback["database"]["database"]["title"], "User edited Project");
      let stopped_complete = state.workspace().stop_project_starter(actor,workspace,input.request_id,&packages).await.unwrap();
      assert_eq!(stopped_complete.status,ProjectStarterStatus::Ready,"stopping a completed result is not cancellation or compensation");
      assert!(state.workspace().get_project_starter(foreign,workspace,input.request_id,&packages).await.unwrap().is_none(),"another accepted member cannot discover the actor-bound receipt");
      assert!(state.workspace().stop_project_starter(foreign,workspace,input.request_id,&packages).await.is_err(),"a different actor cannot stop the original request");
      assert_eq!(state.workspace().get_project_starter(actor,workspace,input.request_id,&packages).await.unwrap().unwrap().status,ProjectStarterStatus::Ready);

      // Inject interruption at the actual native acceptance boundary: identities
      // are durable, while no result exists and no publication has begun.
      let store = myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(pool.clone(),helpers::database_starter_catalog());
      let mut cancelled = input.clone(); cancelled.request_id = Uuid::new_v4();
      let accepted = store.accept_project_starter(actor,workspace,cancelled.request_id,&cancelled.fingerprint(workspace),plan.clone(),first.accepted.admission.clone()).await.unwrap();
      let stopped = state.workspace().stop_project_starter(actor,workspace,cancelled.request_id,&packages).await.unwrap();
      assert_eq!(stopped.status,ProjectStarterStatus::Stopped);
      let resumed = state.workspace().create_project_starter(actor,workspace,cancelled.clone(),&packages).await.unwrap();
      assert_eq!(resumed.status,ProjectStarterStatus::Stopped);
      assert_eq!(resumed.accepted.ids.database_id,accepted.ids.database_id);
      assert!(resumed.database.is_none());
      let created: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_databases WHERE id=$1)").bind(accepted.ids.database_id).fetch_one(&pool).await.unwrap();
      assert!(!created,"stopped accepted identities are never republished");

      // A frozen person is document content, not continuing authority to read
      // an acknowledged result. Readback still checks the requesting actor.
      sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace).bind(foreign).execute(&pool).await.unwrap();
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace).bind(actor).execute(&pool).await.unwrap();
      let reader = state.workspace().get_project_starter(actor,workspace,input.request_id,&packages).await.unwrap().unwrap();
      assert_eq!(reader.status,ProjectStarterStatus::Ready);
      assert_eq!(reader.database.as_ref().unwrap().database.id,id);
      assert!(state.workspace().stop_project_starter(actor,workspace,cancelled.request_id,&packages).await.is_err(),"read access never grants mutation authority");
      sqlx::query("UPDATE workspace_memberships SET role='Owner' WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace).bind(actor).execute(&pool).await.unwrap();
      let departed_person = state.workspace().create_project_starter(actor,workspace,input.clone(),&packages).await.unwrap();
      assert_eq!(departed_person.status,ProjectStarterStatus::Ready);
      assert_eq!(departed_person.accepted.plan.setup.people,vec![foreign]);

      let trashed = native.definition.trash_database_with_precondition(actor,id,Some(edited.database.edit_revision),false).await.unwrap();
      native.definition.delete_database_permanently_with_precondition(actor,id,Some(trashed.database.edit_revision),false).await.unwrap();
      let mut changed = input.clone(); changed.answers.insert(title_input,AssistantValue::Text("Changed request after deletion".into()));
      assert!(matches!(state.workspace().get_project_starter_for_input(actor,workspace,&changed,&packages).await,Err(ProjectStarterError::Conflict)),"changed answers conflict before target Gone");
      assert!(matches!(state.workspace().create_project_starter(actor,workspace,input.clone(),&packages).await,Err(ProjectStarterError::Gone{database_id}) if database_id==id));
      let default_after: Uuid = sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(default_after,default_before,"receipt recovery/deletion never replaces the canonical default");
      let optional: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_databases WHERE workspace_id=$1 AND system_role IS NULL")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      assert_eq!(optional,0,"deleted or stopped results are never allocated again");

      // The actual Roadmap 5/5 combined structure must publish its independent
      // sample graph and explicitly selected scaffold in one native commit.
      let roadmap = packages.list(AssistantPackageContext::ProjectCreation).into_iter().find(|descriptor| {
        descriptor.components.iter().any(|component| matches!(&component.action,
          myoxus_domain::assistant_package::AssistantNativeAction::CreateProject { template_id, .. }
          if template_id == "myoxus.project.product_roadmap"))
      }).expect("actual authored Product Roadmap offering");
      let roadmap_answers = roadmap.inputs.iter().filter_map(|input| {
        let value = match input.target {
          AssistantInputTarget::Title => AssistantValue::Text("Roadmap samples and explicit scaffold".into()),
          AssistantInputTarget::PriorityPreset | AssistantInputTarget::ComplexityPreset | AssistantInputTarget::StructurePreset => {
            let native = if input.target == AssistantInputTarget::StructurePreset { "phases_and_milestones" } else { "fiveStep" };
            let choice = input.choices.iter().find(|choice| matches!(&choice.value, AssistantValue::Choice(value) if value == native)).expect("actual native 5/5 combined choice");
            AssistantValue::Choice(choice.id.clone())
          }
          AssistantInputTarget::IncludeSamples | AssistantInputTarget::IncludeScaffold => AssistantValue::Boolean(true),
          AssistantInputTarget::IncludeComponent => AssistantValue::Boolean(false),
          _ => return None,
        };
        Some((input.id.clone(), value))
      }).collect::<BTreeMap<_,_>>();
      let review = packages.prepare_project(actor,workspace,&roadmap.identity,roadmap_answers.clone(),"en",None).await.unwrap();
      assert_eq!((review.counts.phases,review.counts.milestones,review.counts.sample_rows),(3,1,9));
      let roadmap_input = ProjectStarterInput {
        request_id:Uuid::new_v4(),package:roadmap.identity,answers:roadmap_answers,locale:"en".into(),client_version:None,
        plan_digest:myoxus_application::workspace::assistant_packages::plan_digest(&review),admission_confirmation:None,
      };
      let created = state.workspace().create_project_starter(actor,workspace,roadmap_input.clone(),&packages).await.unwrap();
      assert_eq!(created.status,ProjectStarterStatus::Ready);
      let record = created.database.as_ref().unwrap();
      let phase_field = record.field_roles.iter().find(|role|role.role_key=="milestone.phase").expect("native milestone phase role").field_id;
      let scaffold_milestone = review.setup.scaffold.iter().find(|row|row.kind==myoxus_domain::assistant_package::AssistantProjectScaffoldKind::Milestone).unwrap();
      let preceding_phase = review.setup.scaffold.iter().take_while(|row| row.id!=scaffold_milestone.id)
        .filter(|row|row.kind==myoxus_domain::assistant_package::AssistantProjectScaffoldKind::Phase).last().unwrap();
      let milestone_id = created.accepted.ids.scaffold_rows[&scaffold_milestone.id];
      let phase_id = created.accepted.ids.scaffold_rows[&preceding_phase.id];
      let milestone = native.views.get_row(actor,record.database.id,milestone_id).await.unwrap().expect("persisted native scaffold milestone");
      assert!(matches!(&milestone.cells.iter().find(|cell|cell.field_id==phase_field).unwrap().value,
        myoxus_domain::database::DatabaseCellValueData::Relation(ids) if ids==&[phase_id]));
      let row_count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
        .bind(record.database.id).fetch_one(&pool).await.unwrap();
      assert_eq!(row_count,13,"all nine sample rows and four scaffold rows survive native graph validation");
      let replay = state.workspace().create_project_starter(actor,workspace,roadmap_input,&packages).await.unwrap();
      assert_eq!(replay.accepted.ids.database_id,created.accepted.ids.database_id);
      assert_eq!(replay.accepted.ids.scaffold_rows,created.accepted.ids.scaffold_rows);
      let row_count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
        .bind(record.database.id).fetch_one(&pool).await.unwrap();
      assert_eq!(row_count_after,row_count,"same-key retry never appends scaffold or samples");

    }).catch_unwind().await;
    helpers::cleanup_workspaces(&pool, &owned).await;
    helpers::cleanup_users(&pool, &[actor, foreign]).await;
    if let Err(error) = outcome {
      std::panic::resume_unwind(error);
    }
  });
}

#[test]
fn project_setup_creates_full_native_brief_and_preserves_its_acknowledged_copy() {
  helpers::block_on_large_stack("project-setup-native-brief", || async {
    use futures_util::FutureExt;
    use myoxus_application::{
      feature_bundle::assemble_feature_catalogs,
      template_registry::{TemplateRegistryService, TemplateRegistryStore, bundle},
      workspace::{ProjectStarterInput, ProjectStarterStatus, assistant_packages::AssistantPackageService},
    };
    use myoxus_domain::{assistant_package::*, feature_bundle::*};
    use myoxus_infrastructure::{
      feature_bundles::{pack_captured_feature_bundle, read_feature_bundle},
      storage::StorageAdapter,
      template_registry::SqlxTemplateRegistryStore,
    };
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, sync::Arc};

    let (_, pool, auth_store, state) = helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let (actor, _) = helpers::seed_user(&pool, &auth_store, "native-project-brief-owner").await;
    let slug = format!("test-project-brief-{}", Uuid::new_v4().simple());
    let filename = format!("{slug}.zip");
    let failpoint = format!("wta_brief_{}", Uuid::new_v4().simple());
    let storage_root = tempfile::tempdir().unwrap();
    let storage = Arc::new(StorageAdapter::new_fs(storage_root.path().to_str().unwrap()).unwrap());
    let registry_store = Arc::new(SqlxTemplateRegistryStore::new(pool.clone()));
    let registry =
      Arc::new(TemplateRegistryService::new(registry_store.clone()).with_materialization(state.doc().clone(), storage));
    let mut owned = Vec::new();
    let outcome = std::panic::AssertUnwindSafe(async {
      // Isolate Registry identity while retaining every authored native body.
      // Repack and read the real closed Feature archive; no test-only catalog
      // injection or fabricated source permission bypasses native admission.
      let shipped = helpers::feature_source_set();
      let mut captured = shipped
        .bundles
        .iter()
        .find(|source| source.pin() == shipped.release.base)
        .unwrap()
        .clone();
      let path = "documents/project-brief/1.0.0.zip";
      let mut parsed = bundle::parse_bundle(&captured.files[path]).unwrap();
      parsed.manifest.template_id = slug.clone();
      let bytes = bundle::create_export_bundle(
        &parsed.manifest,
        &parsed.content_bytes,
        None,
        &parsed.localized_contents,
      )
      .unwrap();
      let digest = format!("{:x}", Sha256::digest(&bytes));
      captured.files.insert(path.into(), bytes.clone());
      captured.manifest.files.insert(path.into(), digest.clone());
      let component = captured
        .manifest
        .components
        .iter_mut()
        .find(|component| component.path == path)
        .unwrap();
      component.sha256 = digest;
      component.native_identity.as_mut().unwrap().id = slug.clone();
      let component_id = component.id.clone();
      // The active native Project link keeps this exact component, but the
      // Library no longer offers it as a standalone source.
      captured
        .manifest
        .exports
        .retain(|export| export.source.component != component_id);
      for link in &mut captured.manifest.links {
        if let FeatureLink::DocumentComponent {
          to: FeatureReference::Local { reference },
          ..
        } = link
        {
          if reference.component == component_id {
            reference.export = format!("{slug}@1.0.0");
          }
        }
      }
      let fixture =
        read_feature_bundle(&pack_captured_feature_bundle(&captured.manifest, &captured.files).unwrap()).unwrap();
      let release = FeatureReleaseDescriptor {
        format_version: 1,
        base: fixture.pin(),
      };
      let selection = FeatureBundleCatalogSource {
        format_version: 1,
        base: fixture.pin(),
        optional: vec![],
        retained: vec![],
      };
      let resolved = assemble_feature_catalogs(&release, &selection, &[fixture]).unwrap();
      let native = state.database_services().unwrap();
      let packages = AssistantPackageService::new(
        Arc::new(resolved.assistants),
        Arc::new(resolved.databases),
        native.definition.clone(),
        native.views.clone(),
        Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
          pool.clone(),
          helpers::database_starter_catalog(),
        )),
        state.config.i18n.default_currency.clone(),
        state.config.i18n.default_locale.clone(),
      )
      .with_document_components(state.document_template_service().unwrap(), registry.clone());
      let (entry, mut revision) = registry.stage_shipped_catalog_bundle(&bytes, &filename).await.unwrap();
      // This is the history-only native selection state, including components
      // that have never been standalone publications.
      revision.state = myoxus_domain::template_registry::RevisionState::Deprecated;
      registry_store.update_revision(&revision).await.unwrap();
      assert!(
        registry_store
          .get_latest_published_revision(entry.id)
          .await
          .unwrap()
          .is_none()
      );
      let descriptor = packages
        .list(AssistantPackageContext::ProjectCreation)
        .into_iter()
        .find(|package| package.default_for.contains(&AssistantPackageContext::ProjectCreation))
        .unwrap();
      let brief = descriptor
        .document_components
        .iter()
        .find(|source| source.template_id == slug)
        .unwrap();
      let selector = descriptor
        .components
        .iter()
        .find_map(|component| match &component.action {
          AssistantNativeAction::CreateDocument {
            selected: AssistantValueBinding::Input { input },
            ..
          } if component.id == brief.component_id => Some(input.clone()),
          _ => None,
        })
        .unwrap();
      for (locale, section) in [
        ("en", "Open questions"),
        ("de", "Offene Fragen"),
        ("fr", "Questions ouvertes"),
        ("es", "Preguntas abiertas"),
      ] {
        let workspace = helpers::create_workspace(&pool, actor).await;
        owned.push(workspace);
        state
          .workspace()
          .seed_root_doc(workspace, actor, yjs::create_initial_workspace_doc("Native setup"))
          .await
          .unwrap();
        let answers = descriptor
          .inputs
          .iter()
          .filter_map(|input| match input.target {
            AssistantInputTarget::Title => Some((input.id.clone(), AssistantValue::Text("Native Project".into()))),
            AssistantInputTarget::Goal => Some((
              input.id.clone(),
              AssistantValue::Text("Durable reviewed goal {{workspace.name}}".into()),
            )),
            AssistantInputTarget::IncludeSamples | AssistantInputTarget::IncludeComponent => {
              Some((input.id.clone(), AssistantValue::Boolean(input.id == selector)))
            }
            AssistantInputTarget::Folder => Some((
              input.id.clone(),
              AssistantValue::Folder(AssistantFolderDestination::New {
                name: "Selected folder".into(),
                parent: None,
              }),
            )),
            _ => None,
          })
          .collect::<BTreeMap<_, _>>();
        let plan = packages
          .prepare_project(actor, workspace, &descriptor.identity, answers.clone(), locale, Some(1))
          .await
          .unwrap();
        assert!(plan.execution_available);
        assert_eq!(plan.documents.len(), 1);
        assert_eq!(plan.documents[0].source_revision_id, revision.id);
        let request = ProjectStarterInput {
          request_id: Uuid::new_v4(),
          package: descriptor.identity.clone(),
          answers,
          locale: locale.into(),
          client_version: Some(1),
          plan_digest: myoxus_application::workspace::assistant_packages::plan_digest(&plan),
          admission_confirmation: None,
        };
        if locale == "en" {
          // Fail the actual Organizer write after the child leaf/root ACK,
          // without replacing a persistence owner or swallowing its error.
          sqlx::query(&format!(
            "CREATE FUNCTION {failpoint}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
             IF NEW.workspace_id='{workspace}'::uuid
               AND EXISTS(SELECT 1 FROM docs WHERE id=NEW.doc_id AND external_id='db${workspace}$folders')
               AND EXISTS(SELECT 1 FROM workspace_starter_applications WHERE workspace_id='{workspace}'::uuid
                 AND operation='create_project' AND project_progress->'documents'<>'{{}}'::jsonb)
             THEN RAISE EXCEPTION 'owned Project placement interruption'; END IF; RETURN NEW; END $$"
          ))
          .execute(&pool)
          .await
          .unwrap();
          sqlx::query(&format!(
            "CREATE TRIGGER {failpoint} BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION {failpoint}()"
          ))
          .execute(&pool)
          .await
          .unwrap();
          let interrupted = state
            .workspace()
            .create_project_starter(actor, workspace, request.clone(), &packages)
            .await;
          assert!(
            interrupted.is_err(),
            "the injected native write failure must be observable"
          );
          let partial = state
            .workspace()
            .get_project_starter(actor, workspace, request.request_id, &packages)
            .await
            .unwrap()
            .unwrap();
          assert_eq!(partial.status, ProjectStarterStatus::Pending);
          assert!(partial.documents[0].created && !partial.documents[0].placed);
          let child = &partial.accepted.progress.documents[&brief.component_id];
          let published_search_intent: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM outbox_events WHERE event_type='doc_updated'
             AND aggregate_type='doc' AND aggregate_id=$1::text
             AND payload->>'docId'=$1::text AND payload->>'workspaceId'=$2::text)",
          )
          .bind(child.doc_id)
          .bind(workspace)
          .fetch_one(&pool)
          .await
          .unwrap();
          assert!(
            published_search_intent,
            "Created ACK retains search intent even when later placement rolls back"
          );
          let untouched = state
            .doc()
            .load_full_doc_consistent(workspace, child.doc_id)
            .await
            .unwrap();
          assert!(
            yjs::extract_blocks_from_yjs(&untouched)
              .unwrap()
              .blocks
              .iter()
              .any(|block| block.plain_text.contains("Durable reviewed goal {{workspace.name}}")),
            "partial copy has real text before any opening"
          );
          sqlx::query(&format!("DROP TRIGGER {failpoint} ON doc_updates"))
            .execute(&pool)
            .await
            .unwrap();
          sqlx::query(&format!("DROP FUNCTION {failpoint}()"))
            .execute(&pool)
            .await
            .unwrap();
          state
            .doc()
            .page_lifecycle
            .rename(
              workspace,
              child.doc_id,
              actor,
              "User edited brief".into(),
              Some(child.document_revision),
            )
            .await
            .unwrap();
          let edited = state
            .doc()
            .load_full_doc_consistent(workspace, child.doc_id)
            .await
            .unwrap();
          let mut disabled = entry.clone();
          disabled.status = myoxus_domain::template_registry::TemplateStatus::Disabled;
          registry_store.update_catalog_entry(&disabled).await.unwrap();
          let resumed = state
            .workspace()
            .create_project_starter(actor, workspace, request.clone(), &packages)
            .await
            .unwrap();
          assert_eq!(
            resumed.status,
            ProjectStarterStatus::Ready,
            "already created working copies do not require their source again"
          );
          assert_eq!(resumed.accepted.ids.database_id, partial.accepted.ids.database_id);
          assert_eq!(resumed.accepted.ids.documents[0].doc_id, child.doc_id);
          assert_eq!(
            state
              .doc()
              .load_full_doc_consistent(workspace, child.doc_id)
              .await
              .unwrap(),
            edited,
            "remaining placement must preserve edits made after Created"
          );
          registry_store.update_catalog_entry(&entry).await.unwrap();
        }
        let (first, retry) = tokio::join!(
          state
            .workspace()
            .create_project_starter(actor, workspace, request.clone(), &packages),
          state
            .workspace()
            .create_project_starter(actor, workspace, request.clone(), &packages),
        );
        let first = first.unwrap();
        let retry = retry.unwrap();
        assert_eq!(first.status, ProjectStarterStatus::Ready);
        assert_eq!(retry.status, ProjectStarterStatus::Ready);
        assert_eq!(first.accepted.ids.database_id, retry.accepted.ids.database_id);
        assert_eq!(
          first.accepted.ids.documents[0].doc_id,
          retry.accepted.ids.documents[0].doc_id
        );
        assert!(first.documents[0].created && first.documents[0].placed);
        let document = &first.accepted.progress.documents[&brief.component_id];
        let search_payloads: Vec<serde_json::Value> = sqlx::query_scalar(
          "SELECT payload FROM outbox_events WHERE event_type='doc_updated'
           AND aggregate_type='doc' AND aggregate_id=$1::text",
        )
        .bind(document.doc_id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
          search_payloads.iter().any(|payload| payload
            == &json!({
              "docId": document.doc_id.to_string(), "workspaceId": workspace.to_string(),
            })),
          "{locale}: unopened native Brief requires durable search intent for its exact internal identity",
        );
        // Read the durable leaf before any browser/editor ever opens it.
        let leaf = state
          .doc()
          .load_full_doc_consistent(workspace, document.doc_id)
          .await
          .unwrap();
        let extracted = yjs::extract_blocks_from_yjs(&leaf).unwrap();
        assert!(!extracted.extraction_partial);
        let text = extracted
          .blocks
          .iter()
          .map(|block| block.plain_text.as_str())
          .collect::<Vec<_>>()
          .join("\n");
        assert!(
          text.contains("Durable reviewed goal {{workspace.name}}"),
          "{locale}: literal inserted braces were re-evaluated: {text}"
        );
        assert!(
          text.contains(section),
          "{locale}: complete localized native body absent: {text}"
        );
        assert!(!text.contains("{{project."));
        let template_state: bool =
          sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM document_template_state WHERE doc_id=$1)")
            .bind(document.doc_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!template_state, "a working copy is an ordinary native document");
        let organizer = myoxus_application::organizer::OrganizerService::new(state.doc().clone())
          .snapshot(workspace)
          .await
          .unwrap();
        fn find<'a>(
          nodes: &'a [myoxus_application::organizer::OrganizerSnapshotNode],
          id: &str,
        ) -> Option<&'a myoxus_application::organizer::OrganizerSnapshotNode> {
          nodes.iter().find_map(|node| {
            if node.row.id == id {
              Some(node)
            } else {
              find(&node.children, id)
            }
          })
        }
        let folder = find(&organizer.roots, first.accepted.ids.folder_id.as_deref().unwrap()).unwrap();
        assert!(folder.row.is_folder());
        assert_eq!(folder.row.data, "Selected folder");
        let link = find(&organizer.roots, &first.accepted.ids.documents[0].entry_id).unwrap();
        assert_eq!(link.row.row_type, "doc");
        assert_eq!(link.row.data, document.external_id);
        assert_eq!(link.row.parent_id, first.accepted.ids.folder_id);
        let before = leaf.clone();
        let replay = state
          .workspace()
          .create_project_starter(actor, workspace, request.clone(), &packages)
          .await
          .unwrap();
        assert_eq!(
          replay.documents[0].external_id.as_deref(),
          Some(document.external_id.as_str())
        );
        assert_eq!(
          state
            .doc()
            .load_full_doc_consistent(workspace, document.doc_id)
            .await
            .unwrap(),
          before,
          "replay never rewrites an acknowledged body"
        );
        assert!(
          registry_store.delete_catalog_entry(entry.id).await.is_err(),
          "accepted immutable source remains retained"
        );
      }
    })
    .catch_unwind()
    .await;
    sqlx::query(&format!("DROP TRIGGER IF EXISTS {failpoint} ON doc_updates"))
      .execute(&pool)
      .await
      .expect("owned interruption trigger cleanup");
    sqlx::query(&format!("DROP FUNCTION IF EXISTS {failpoint}()"))
      .execute(&pool)
      .await
      .expect("owned interruption function cleanup");
    // Include allocations accepted before an interrupted call returned its ID.
    let accepted_workspaces: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE created_by_user_id=$1")
      .bind(actor)
      .fetch_all(&pool)
      .await
      .expect("owned accepted Workspace allocations");
    owned.extend(accepted_workspaces);
    owned.sort_unstable();
    owned.dedup();
    helpers::cleanup_workspaces(&pool, &owned).await;
    let remaining_document_events: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM outbox_events WHERE event_type IN ('doc_updated','workspace_doc_broadcast')
       AND payload->>'workspaceId' IN (SELECT unnest($1::uuid[])::text))",
    )
    .bind(&owned)
    .fetch_one(&pool)
    .await
    .expect("verify owned Brief outbox cleanup");
    helpers::cleanup_users(&pool, &[actor]).await;
    let jobs: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT import_job_id FROM template_registry_audit_events WHERE payload_json->>'filename'=$1 AND import_job_id IS NOT NULL")
      .bind(&filename).fetch_all(&pool).await.expect("owned import jobs");
    sqlx::query("DELETE FROM template_registry_audit_events WHERE import_job_id=ANY($1)")
      .bind(&jobs)
      .execute(&pool)
      .await
      .expect("owned import audits");
    sqlx::query("DELETE FROM template_import_jobs WHERE id=ANY($1)")
      .bind(&jobs)
      .execute(&pool)
      .await
      .expect("owned import jobs cleanup");
    if let Some(id) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM template_catalog_entries WHERE slug=$1")
      .bind(&slug)
      .fetch_optional(&pool)
      .await
      .unwrap()
    {
      registry_store
        .delete_catalog_entry(id)
        .await
        .expect("owned source cleanup after receipt cleanup");
    }
    assert!(
      !remaining_document_events,
      "Brief workspaces must leave no search/broadcast intent"
    );
    if let Err(error) = outcome {
      std::panic::resume_unwind(error);
    }
  });
}

#[test]
fn workspace_creation_rejects_combined_setup_before_allocation() {
  helpers::block_on_large_stack("workspace-composition-rejection", || async {
    use futures_util::FutureExt;
    use myoxus_application::workspace::*;
    use myoxus_domain::assistant_package::*;
    use std::collections::BTreeMap;

    let (app, pool, auth_store, state) = helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let (actor, session) = helpers::seed_user(&pool, &auth_store, "workspace-purpose-owner").await;
    let outcome = std::panic::AssertUnwindSafe(async {
      let packages = state.assistant_packages().unwrap();
      let catalog = packages.list(AssistantPackageContext::WorkspaceCreation);
      let empty = catalog.iter().find(|source| source.default_for.contains(&AssistantPackageContext::WorkspaceCreation)).unwrap();
      assert_eq!(catalog.len(), 1);
      assert!(empty.components.iter().any(|component| matches!(component.action, AssistantNativeAction::CreateWorkspace { .. })));
      let project = packages.list(AssistantPackageContext::ProjectCreation).into_iter().next().expect("ordinary Project offering remains available");
      let answers = empty.inputs.iter().filter_map(|input| match input.target {
        AssistantInputTarget::WorkspaceName => Some((input.id.clone(), AssistantValue::Text("Direct Empty".into()))),
        AssistantInputTarget::AssistanceMode => Some((input.id.clone(), AssistantValue::Choice(input.choices.iter()
          .find(|choice| matches!(&choice.value, AssistantValue::Choice(value) if value == "guided"))
          .expect("native Guided assistance choice").id.clone()))),
        _ => None,
      }).collect::<BTreeMap<_,_>>();
      let prepared = packages.prepare_workspace_creation(actor, &empty.identity, answers.clone(), None, None, state.auth()).await.unwrap();
      let selected = WorkspaceStarterProjectInput {
        package: project.identity.clone(), answers: BTreeMap::new(), locale: "en".into(), client_version: Some(1),
      };
      let setup = WorkspaceStarterSetupInput {
        package: project.identity.clone(), answers: BTreeMap::new(), locale: "en".into(), client_version: 1,
      };
      let counts = "SELECT (SELECT count(*) FROM workspaces WHERE created_by_user_id=$1),(SELECT count(*) FROM docs WHERE created_by=$1),(SELECT count(*) FROM workspace_starter_applications WHERE actor_id=$1),(SELECT count(*) FROM user_preferences WHERE user_id=$1)";
      let before: (i64,i64,i64,i64) = sqlx::query_as(counts).bind(actor).fetch_one(&pool).await.unwrap();
      for (project, setup) in [(Some(selected.clone()), None), (None, Some(setup.clone())), (Some(selected), Some(setup))] {
        let error = packages.prepare_workspace_creation(actor, &empty.identity, answers.clone(), project.as_ref(), setup.as_ref(), state.auth()).await.unwrap_err();
        assert_eq!(error.message, "Workspace creation does not accept Project or document setup");
        let request = WorkspaceStarterInput {
          project: project.clone(), setup: setup.clone(), admission_confirmation: None,
          request_id: Uuid::new_v4(), name: prepared.name.clone(), initial_content: prepared.initial_content,
          assistance_mode: prepared.assistance_mode, package: prepared.package.clone(),
          answers: prepared.answers.clone(), plan_digest: prepared.plan_digest(actor),
        };
        assert!(state.workspace().create_workspace_starter(actor, request.clone(), Some(packages.as_ref()), state.auth()).await.is_err(),
          "native callers cannot bypass composition admission");
        let mut input = json!({
          "name": request.name, "initialContent": "Empty", "assistanceMode": "Guided", "requestId": request.request_id,
          "assistantConfirmation": {"identity": request.package, "answers": request.answers, "planDigest": request.plan_digest},
        });
        if let Some(project) = project {
          input["project"] = json!({"package": project.package, "answers": project.answers, "locale": project.locale, "clientVersion": project.client_version});
        }
        if let Some(setup) = setup {
          input["setup"] = json!({"package": setup.package, "answers": setup.answers, "locale": setup.locale, "clientVersion": setup.client_version});
        }
        let rejected = helpers::gql(&app, session, json!({
          "query": "mutation($input:CreateWorkspaceInput!){createWorkspace(input:$input){id}}",
          "variables": {"input": input},
        })).await;
        assert!(rejected.get("errors").is_some(), "withdrawn composition accepted: {rejected}");
      }
      let after: (i64,i64,i64,i64) = sqlx::query_as(counts).bind(actor).fetch_one(&pool).await.unwrap();
      assert_eq!(before, after, "withdrawn compositions allocate no Workspace, document, receipt or preference");
    }).catch_unwind().await;
    let owned: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM workspaces WHERE created_by_user_id=$1")
      .bind(actor)
      .fetch_all(&pool)
      .await
      .unwrap();
    helpers::cleanup_workspaces(&pool, &owned).await;
    helpers::cleanup_users(&pool, &[actor]).await;
    if let Err(error) = outcome {
      std::panic::resume_unwind(error);
    }
  });
}
