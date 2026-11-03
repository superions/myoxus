// SPDX-License-Identifier: AGPL-3.0-or-later

use super::*;
use myoxus_application::auth::AssistanceMode;
use myoxus_application::workspace::{
  WorkspaceStarterAllocation, WorkspaceStarterError, WorkspaceStarterReceipt, WorkspaceStarterResult,
};
use myoxus_domain::assistant_package::AssistantPackageIdentity;
use myoxus_domain::database::{DatabaseManagedSchemaReadiness, DatabaseViewRepository};

impl SqlxWorkspaceStore {
  async fn starter_in_tx(
    &self,
    tx: &mut PgConnection,
    actor: Uuid,
    request_id: Uuid,
    expected_fingerprint: Option<&str>,
  ) -> WorkspaceStarterResult<Option<WorkspaceStarterAllocation>> {
    let receipt = sqlx::query("SELECT * FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2")
      .bind(actor).bind(request_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let Some(receipt) = receipt else {
      return Ok(None);
    };
    // The active actor owns this accepted key even when its result is gone.
    // Changed input conflicts before target lookup; it must never reserve anew.
    let fingerprint: String = receipt.try_get("fingerprint").map_err(Self::map_db_err)?;
    if expected_fingerprint.is_some_and(|expected| fingerprint != expected) {
      return Err(WorkspaceStarterError::Conflict);
    }
    let workspace_id: Uuid = receipt.try_get("workspace_id").map_err(Self::map_db_err)?;
    let workspace =
      sqlx::query("SELECT * FROM workspaces WHERE id=$1 AND deleted_at IS NULL AND lifecycle_state='active' FOR SHARE")
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or(WorkspaceStarterError::Gone { workspace_id })?;
    sqlx::query("SELECT workspace_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE")
      .bind(workspace_id).bind(actor).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    let root_ready: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND workspace_id=$1 AND is_workspace_root AND (EXISTS(SELECT 1 FROM doc_updates WHERE doc_id=$1 AND workspace_id=$1) OR EXISTS(SELECT 1 FROM doc_snapshots WHERE doc_id=$1 AND workspace_id=$1)))")
      .bind(workspace_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
    let tasks = sqlx::query("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks' AND deleted_at IS NULL FOR SHARE")
      .bind(workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    let tasks_database_id = tasks
      .as_ref()
      .map(|row| row.try_get("id"))
      .transpose()
      .map_err(Self::map_db_err)?;
    let tasks_ready = false;
    let reason_code = (!root_ready).then(|| "WORKSPACE_ROOT_UNAVAILABLE".into());
    let mode: String = receipt.try_get("assistance_mode").map_err(Self::map_db_err)?;
    let assistance_mode: AssistanceMode = serde_json::from_value(serde_json::Value::String(mode))
      .map_err(|_| AuthError::Storage("invalid Workspace assistance receipt".into()))?;
    Ok(Some(WorkspaceStarterAllocation {
      setup: Self::setup_from_row(&receipt)?,
      workspace: map_workspace_row(workspace).map_err(Self::map_db_err)?,
      receipt: WorkspaceStarterReceipt {
        setup_definition: None,
        prepared: receipt
          .try_get::<Option<serde_json::Value>, _>("workspace_plan")
          .map_err(Self::map_db_err)?
          .map(serde_json::from_value)
          .transpose()
          .map_err(|_| AuthError::Storage("invalid accepted Workspace plan".into()))?,
        actor_id: actor,
        request_id,
        workspace_id,
        fingerprint,
        name: receipt.try_get("name").map_err(Self::map_db_err)?,
        assistance_mode,
        package: AssistantPackageIdentity {
          id: receipt.try_get("package_id").map_err(Self::map_db_err)?,
          version: receipt.try_get("package_version").map_err(Self::map_db_err)?,
          digest: receipt.try_get("package_digest").map_err(Self::map_db_err)?,
        },
        assistance_saved: receipt
          .try_get::<Option<DateTime<Utc>>, _>("assistance_saved_at")
          .map_err(Self::map_db_err)?
          .is_some(),
      },
      root_ready,
      tasks_ready,
      tasks_database_id,
      reason_code,
    }))
  }
  async fn starter_readiness(&self, allocation: &mut WorkspaceStarterAllocation) -> WorkspaceStarterResult<()> {
    let repository =
      crate::workspace_database::PgDatabaseRepository::new(self.pool.clone(), self.database_templates.clone());
    let page = match repository.task_destinations(allocation.workspace.id, 1, None).await {
      Ok(page) => page,
      Err(_) => {
        allocation.tasks_ready = false;
        allocation.reason_code = Some("WORKSPACE_TASKS_READINESS_UNAVAILABLE".into());
        return Ok(());
      }
    };
    allocation.tasks_database_id = page
      .default_destination
      .as_ref()
      .map(|destination| destination.database_id);
    allocation.tasks_ready = page
      .default_destination
      .as_ref()
      .is_some_and(|destination| destination.managed_schema.readiness == DatabaseManagedSchemaReadiness::Ready);
    if allocation.root_ready && !allocation.tasks_ready {
      allocation.reason_code = page
        .default_destination
        .as_ref()
        .and_then(|destination| destination.managed_schema.reason_code.clone())
        .or_else(|| Some("WORKSPACE_TASKS_UNAVAILABLE".into()));
    }
    Ok(())
  }
  pub(super) async fn read_workspace_starter(
    &self,
    actor: Uuid,
    request_id: Uuid,
    expected_fingerprint: Option<&str>,
  ) -> WorkspaceStarterResult<Option<WorkspaceStarterAllocation>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE")
      .bind(actor)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    let mut result = self
      .starter_in_tx(&mut tx, actor, request_id, expected_fingerprint)
      .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    if let Some(allocation) = result.as_mut() {
      self.starter_readiness(allocation).await?;
    }
    Ok(result)
  }
  pub(super) async fn insert_workspace_starter(
    &self,
    receipt: WorkspaceStarterReceipt,
    root_update: Vec<u8>,
  ) -> WorkspaceStarterResult<WorkspaceStarterAllocation> {
    if receipt.request_id.is_nil() || root_update.is_empty() {
      return Err(AuthError::InvalidInput("invalid Workspace starter allocation".into()).into());
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_name_principal(&mut tx, "user", receipt.actor_id).await?;
    let active: bool = sqlx::query_scalar("SELECT status='active' FROM users WHERE id=$1")
      .bind(receipt.actor_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if !active {
      return Err(AuthError::ActionForbidden.into());
    }
    // The native name-principal lock also serializes same-actor allocation.
    // A concurrent winner is read before any second root or receipt is written.
    if let Some(existing) = self
      .starter_in_tx(
        &mut tx,
        receipt.actor_id,
        receipt.request_id,
        Some(&receipt.fingerprint),
      )
      .await?
    {
      tx.commit().await.map_err(Self::map_db_err)?;
      let mut existing = existing;
      self.starter_readiness(&mut existing).await?;
      return Ok(existing);
    }
    let name = WorkspaceName::parse(&receipt.name).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    Self::require_available_name(&mut tx, "user", receipt.actor_id, &name, None).await?;
    sqlx::query("INSERT INTO workspaces(id,owner_user_id,owner_principal_type,owner_principal_id,created_by_user_id,is_personal_workspace,name,name_normalized,public,initial_content_policy) VALUES($1,$2,'user',$2,$2,false,$3,$4,false,'empty')")
      .bind(receipt.workspace_id).bind(receipt.actor_id).bind(name.display()).bind(name.normalized())
      .execute(&mut *tx).await.map_err(Self::map_db_err)?;
    sqlx::query(
      "INSERT INTO docs(id,workspace_id,title,is_workspace_root,created_by,updated_by) VALUES($1,$1,$2,true,$3,$3)",
    )
    .bind(receipt.workspace_id)
    .bind(name.display())
    .bind(receipt.actor_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$1,$2,1)")
      .bind(receipt.workspace_id)
      .bind(root_update)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'Owner','Accepted',now())")
      .bind(receipt.workspace_id).bind(receipt.actor_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    let state = myoxus_application::workspace::tasks::workspace_tasks_initial_state(
      &self.database_templates,
      receipt.workspace_id,
      Some(receipt.actor_id),
    )
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    crate::workspace_database::PgDatabaseRepository::ensure_workspace_tasks_in_tx(
      &mut tx,
      &self.database_templates,
      state,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    let project = receipt.prepared.as_ref().and_then(|prepared| prepared.project.as_ref());
    let ids = project.map(Self::reserve_project_ids);
    let admission = project
      .map(|plan| {
        myoxus_application::workspace::assistant_packages::review_project_admission(&self.database_templates, plan)
      })
      .transpose()
      .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    if let Some(project) = project {
      if project.actor_id != receipt.actor_id
        || project.workspace_id.is_some()
        || project.setup.people.iter().any(|id| *id != receipt.actor_id)
        || project.folder.as_ref().is_some_and(|folder| {
          !matches!(
            folder,
            myoxus_domain::assistant_package::AssistantFolderDestination::New { parent: None, .. }
          )
        })
      {
        return Err(AuthError::InvalidInput("invalid preallocation Project scope".into()).into());
      }
      Self::lock_project_sources(&mut tx, project).await?;
    }
    let setup = receipt.prepared.as_ref().and_then(|prepared| prepared.setup.as_ref());
    if setup.is_some() && project.is_some() {
      return Err(AuthError::InvalidInput("choose one optional Workspace setup".into()).into());
    }
    let setup_run_id = setup.map(|_| Uuid::new_v4());
    let setup_reservations = setup.map(|plan| {
      plan
        .components
        .iter()
        .map(
          |component| myoxus_application::workspace::assistant_packages::WorkspaceSetupReservation {
            component_id: component.id.clone(),
            result_id: Uuid::new_v4(),
            entry_id: Uuid::new_v4().to_string(),
          },
        )
        .collect::<Vec<_>>()
    });
    let folder_id = setup
      .and_then(|plan| plan.folder.as_ref())
      .map(|_| Uuid::new_v4().to_string());
    let setup_document_ids=setup.map(|plan|serde_json::json!({"folderId":folder_id,"documents":plan.document_metadata.iter().map(|document|{
      let reserved=setup_reservations.as_ref().and_then(|ids|ids.iter().find(|id|id.component_id==document.source.component_id)).expect("selected components reserve their identities");
      myoxus_application::workspace::ProjectStarterDocumentIds{component_id:reserved.component_id.clone(),doc_id:reserved.result_id,entry_id:reserved.entry_id.clone()}
    }).collect::<Vec<_>>()}));
    if let Some(setup) = setup {
      if setup.actor_id != receipt.actor_id
        || setup.workspace_id.is_some()
        || !setup.execution_available
        || !setup.documents.is_empty()
      {
        return Err(AuthError::InvalidInput("invalid preallocation Workspace setup".into()).into());
      }
      let definition = receipt
        .setup_definition
        .as_ref()
        .ok_or_else(|| AuthError::InvalidInput("Workspace workflow unavailable".into()))?;
      let compiled =
        myoxus_application::workspace_automation::setup::compile_workspace_setup(setup, definition.policy.clone())
          .map_err(|_| AuthError::InvalidInput("Workspace workflow unavailable".into()))?;
      if compiled.hash != definition.hash {
        return Err(AuthError::InvalidInput("Workspace workflow changed".into()).into());
      }
      Self::lock_source_pins(
        &mut tx,
        setup
          .document_metadata
          .iter()
          .map(|doc| (doc.source_revision_id, &doc.source, &doc.source_revision_digest))
          .collect(),
        Some(setup.client_version),
      )
      .await?;
    }
    let mode = serde_json::to_value(receipt.assistance_mode).expect("typed mode serializes");
    let encode = |value| serde_json::to_value(value).map_err(|error| AuthError::Storage(error.to_string()));
    sqlx::query("INSERT INTO workspace_starter_applications(actor_id,request_id,fingerprint,package_id,package_version,package_digest,workspace_id,name,assistance_mode,workspace_plan,project_result_ids,project_admission,project_state,project_progress,setup_result_ids,setup_progress,automation_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)")
      .bind(receipt.actor_id).bind(receipt.request_id).bind(&receipt.fingerprint)
      .bind(&receipt.package.id).bind(&receipt.package.version).bind(&receipt.package.digest)
      .bind(receipt.workspace_id).bind(&receipt.name).bind(mode.as_str().expect("mode string"))
      .bind(receipt.prepared.as_ref().map(serde_json::to_value).transpose().map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(if let Some(ids)=&setup_document_ids {Some(ids.clone())}else{ids.as_ref().map(serde_json::to_value).transpose().map_err(|error|AuthError::Storage(error.to_string()))?})
      .bind(admission.as_ref().map(serde_json::to_value).transpose().map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind((project.is_some()||setup.is_some()).then_some("accepted"))
      .bind(if project.is_some()||setup.is_some(){Some(encode(myoxus_application::workspace::ProjectStarterProgress::default())?)}else{None})
      .bind(setup_reservations.as_ref().map(serde_json::to_value).transpose().map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(setup.map(|_|serde_json::to_value(myoxus_application::workspace::assistant_packages::WorkspaceSetupProgress::default())).transpose().map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(setup_run_id)
      .execute(&mut *tx).await.map_err(Self::map_db_err)?;
    if let Some(run_id) = setup_run_id {
      use myoxus_domain::workspace_automation::*;
      let run = AcceptedAutomationRun {
        recurring_task: None,
        workspace_setup: Some(AcceptedWorkspaceSetupRequest {
          request_id: receipt.request_id,
          fingerprint: receipt.fingerprint.clone(),
        }),
        run_id,
        automation_id: None,
        workspace_id: receipt.workspace_id,
        actor_id: Some(receipt.actor_id),
        trigger: None,
        confirmed_request: None,
        document_review: None,
        task_handover: None,
        task_maintenance: None,
        personal_rule: None,
        definition: receipt
          .setup_definition
          .clone()
          .ok_or_else(|| AuthError::InvalidInput("Workspace workflow unavailable".into()))?,
      };
      sqlx::query("INSERT INTO workspace_automation_runs(id,workspace_id,idempotency_key,status,accepted_json,origin_kind,confirmed_actor_id,confirmed_operation,confirmed_request_id) VALUES($1,$2,$3,'queued',$4,'workspace_setup',$5,'create_workspace',$6)")
        .bind(run_id).bind(receipt.workspace_id).bind(&receipt.fingerprint).bind(serde_json::to_value(run).map_err(|error|AuthError::Storage(error.to_string()))?).bind(receipt.actor_id).bind(receipt.request_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    }
    let mut result = self
      .starter_in_tx(
        &mut tx,
        receipt.actor_id,
        receipt.request_id,
        Some(&receipt.fingerprint),
      )
      .await?
      .expect("the transaction inserted its allocation receipt");
    tx.commit().await.map_err(Self::map_db_err)?;
    self.starter_readiness(&mut result).await?;
    Ok(result)
  }
}

impl SqlxWorkspaceStore {
  /// Authority locks precede request/root locks, matching Workspace deletion.
  pub(crate) async fn project_authority(
    tx: &mut PgConnection,
    actor: Uuid,
    workspace: Uuid,
    action: myoxus_domain::permission::WorkspaceAction,
  ) -> AuthResult<()> {
    sqlx::query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE")
      .bind(actor)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    sqlx::query("SELECT id FROM workspaces WHERE id=$1 AND lifecycle_state='active' AND deleted_at IS NULL FOR SHARE")
      .bind(workspace)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    let role: Option<String> = sqlx::query_scalar(
      "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE",
    )
    .bind(workspace)
    .bind(actor)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let role = match role.as_deref().ok_or(AuthError::ActionForbidden)? {
      "Owner" => WorkspaceRole::Owner,
      "Admin" => WorkspaceRole::Admin,
      "Manager" => WorkspaceRole::Manager,
      "Collaborator" => WorkspaceRole::Collaborator,
      "Commenter" => WorkspaceRole::Commenter,
      "Reader" => WorkspaceRole::Reader,
      _ => return Err(AuthError::ActionForbidden),
    };
    if !role.can(action) {
      return Err(AuthError::ActionForbidden);
    }
    Ok(())
  }
  pub(crate) async fn project_members(
    tx: &mut PgConnection,
    workspace: Uuid,
    plan: &myoxus_domain::assistant_package::AssistantPreparedProject,
  ) -> AuthResult<()> {
    let mut people = plan.setup.people.clone();
    people.sort();
    people.dedup();
    for person in people {
      sqlx::query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE")
        .bind(workspace).bind(person).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or(AuthError::ActionForbidden)?;
    }
    Ok(())
  }
  fn reserve_project_ids(
    plan: &myoxus_domain::assistant_package::AssistantPreparedProject,
  ) -> myoxus_application::workspace::ProjectStarterIds {
    use myoxus_application::workspace::*;
    ProjectStarterIds {
      database_id: Uuid::new_v4(),
      scaffold_rows: plan
        .setup
        .scaffold
        .iter()
        .map(|row| (row.id.clone(), Uuid::new_v4()))
        .collect(),
      documents: plan
        .documents
        .iter()
        .map(|document| &document.source)
        .chain(plan.document_metadata.iter().map(|document| &document.source))
        .map(|source| ProjectStarterDocumentIds {
          component_id: source.component_id.clone(),
          doc_id: Uuid::new_v4(),
          entry_id: Uuid::new_v4().to_string(),
        })
        .collect(),
      folder_id: plan.folder.as_ref().map(|folder| match folder {
        myoxus_domain::assistant_package::AssistantFolderDestination::Existing { id } => id.clone(),
        myoxus_domain::assistant_package::AssistantFolderDestination::New { .. } => Uuid::new_v4().to_string(),
      }),
      project_entry_id: plan.folder.as_ref().map(|_| Uuid::new_v4().to_string()),
    }
  }
  fn project_from_row(
    row: &sqlx::postgres::PgRow,
  ) -> myoxus_application::workspace::ProjectStarterResult<myoxus_application::workspace::AcceptedProjectStarter> {
    use myoxus_application::workspace::*;
    let decode = |name: &str| -> AuthResult<serde_json::Value> { row.try_get(name).map_err(Self::map_db_err) };
    let plan = match row
      .try_get::<Option<serde_json::Value>, _>("project_plan")
      .map_err(Self::map_db_err)?
    {
      Some(plan) => {
        serde_json::from_value(plan).map_err(|_| AuthError::Storage("invalid accepted Project plan".into()))?
      }
      None => {
        let prepared: myoxus_application::workspace::assistant_packages::PreparedWorkspaceAssistant =
          serde_json::from_value(decode("workspace_plan")?)
            .map_err(|_| AuthError::Storage("invalid accepted Workspace plan".into()))?;
        prepared
          .project
          .ok_or_else(|| AuthError::Storage("accepted Project review missing".into()))?
      }
    };
    Ok(AcceptedProjectStarter {
      operation: serde_json::from_value(serde_json::Value::String(
        row.try_get("operation").map_err(Self::map_db_err)?,
      ))
      .map_err(|_| AuthError::Storage("invalid starter operation".into()))?,
      actor_id: row.try_get("actor_id").map_err(Self::map_db_err)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_db_err)?,
      request_id: row.try_get("request_id").map_err(Self::map_db_err)?,
      fingerprint: row.try_get("fingerprint").map_err(Self::map_db_err)?,
      plan,
      ids: serde_json::from_value(decode("project_result_ids")?)
        .map_err(|_| AuthError::Storage("invalid accepted Project identities".into()))?,
      progress: serde_json::from_value(decode("project_progress")?)
        .map_err(|_| AuthError::Storage("invalid Project progress".into()))?,
      admission: serde_json::from_value(decode("project_admission")?)
        .map_err(|_| AuthError::Storage("invalid Project admission".into()))?,
      state: serde_json::from_value(serde_json::Value::String(
        row.try_get("project_state").map_err(Self::map_db_err)?,
      ))
      .map_err(|_| AuthError::Storage("invalid Project starter state".into()))?,
    })
  }
  pub(crate) async fn project_receipt(
    tx: &mut PgConnection,
    actor: Uuid,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: Uuid,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> myoxus_application::workspace::ProjectStarterResult<Option<myoxus_application::workspace::AcceptedProjectStarter>>
  {
    use myoxus_application::workspace::*;
    let row = sqlx::query(
      "SELECT * FROM workspace_starter_applications WHERE actor_id=$1 AND operation=$3 AND request_id=$2 FOR UPDATE",
    )
    .bind(actor)
    .bind(request)
    .bind(operation.as_str())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some(row) = row else { return Ok(None) };
    if row
      .try_get::<Option<String>, _>("project_state")
      .map_err(Self::map_db_err)?
      .is_none()
    {
      return Ok(None);
    }
    let receipt = Self::project_from_row(&row)?;
    if receipt.plan.actor_id != actor
      || receipt.plan.workspace_id.is_some_and(|id| id != workspace)
      || (receipt.plan.workspace_id.is_none()
        && (operation != StarterOperation::CreateWorkspace || receipt.progress.project_created))
    {
      return Err(AuthError::Storage("invalid accepted Project target scope".into()).into());
    }
    if receipt.workspace_id != workspace || fingerprint.is_some_and(|expected| expected != receipt.fingerprint) {
      return Err(ProjectStarterError::Conflict);
    }
    let mut document_ids = std::collections::BTreeSet::new();
    for reserved in &receipt.ids.documents {
      if !document_ids.insert(&reserved.component_id)
        || !receipt
          .plan
          .documents
          .iter()
          .map(|document| &document.source)
          .chain(receipt.plan.document_metadata.iter().map(|document| &document.source))
          .any(|source| source.component_id == reserved.component_id)
      {
        return Err(AuthError::Storage("invalid reserved Project document identity".into()).into());
      }
    }
    if document_ids.len() != receipt.plan.documents.len() + receipt.plan.document_metadata.len()
      || receipt
        .ids
        .documents
        .iter()
        .map(|ids| ids.doc_id)
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != document_ids.len()
      || receipt
        .ids
        .documents
        .iter()
        .map(|ids| &ids.entry_id)
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != document_ids.len()
      || (!receipt.progress.project_created
        && (receipt.progress.folder_ready
          || !receipt.progress.documents.is_empty()
          || receipt.progress.placement_complete))
      || (receipt.progress.placement_complete && receipt.progress.documents.len() != document_ids.len())
      || (receipt.progress.documents.values().any(|result| result.placed) && !receipt.progress.folder_ready)
      || (receipt.progress.placement_complete && receipt.progress.documents.values().any(|result| !result.placed))
      || (receipt.progress.folder_ready && receipt.ids.folder_id.is_none())
      || (receipt.state == ProjectStarterState::Complete && !receipt.progress.placement_complete)
    {
      return Err(AuthError::Storage("invalid Project progress frontier".into()).into());
    }
    for (component, result) in &receipt.progress.documents {
      if !receipt
        .ids
        .documents
        .iter()
        .any(|reserved| reserved.component_id == *component && reserved.doc_id == result.doc_id)
        || result.external_id != result.doc_id.to_string()
        || result.document_revision <= 0
        || result.root_revision <= 0
      {
        return Err(AuthError::Storage("invalid Project document acknowledgement".into()).into());
      }
      let actual = sqlx::query("SELECT workspace_id,external_id FROM docs WHERE id=$1")
        .bind(result.doc_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      if operation == StarterOperation::CreateProject
        && actual.as_ref().is_some_and(|row| {
          row.get::<Option<Uuid>, _>("workspace_id") != Some(workspace)
            || row.get::<String, _>("external_id") != result.external_id
        })
      {
        return Err(ProjectStarterError::Conflict);
      }
    }
    if receipt.progress.project_created || receipt.state == ProjectStarterState::Complete {
      let owner: Option<Uuid> =
        sqlx::query_scalar("SELECT workspace_id FROM workspace_databases WHERE id=$1 FOR SHARE")
          .bind(receipt.ids.database_id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
      match owner {
        None if operation == StarterOperation::CreateProject => {
          return Err(ProjectStarterError::Gone {
            database_id: receipt.ids.database_id,
          });
        }
        Some(owner) if owner != workspace && operation == StarterOperation::CreateProject => {
          return Err(ProjectStarterError::Conflict);
        }
        // A composed child's disappearance never hides its enclosing allocation.
        // Its committed progress remains authoritative and forbids re-creation.
        _ => {}
      }
    }
    Ok(Some(receipt))
  }
  pub(crate) async fn lock_project_sources(
    tx: &mut PgConnection,
    plan: &myoxus_domain::assistant_package::AssistantPreparedProject,
  ) -> AuthResult<()> {
    // Publication/retirement lock every catalog root before any revision.
    let documents = plan
      .documents
      .iter()
      .map(|document| {
        (
          document.source_revision_id,
          &document.source,
          &document.source_revision_digest,
        )
      })
      .chain(plan.document_metadata.iter().map(|document| {
        (
          document.source_revision_id,
          &document.source,
          &document.source_revision_digest,
        )
      }))
      .collect::<Vec<_>>();
    Self::lock_source_pins(tx, documents, plan.client_version).await
  }
  pub(crate) async fn lock_source_pins(
    tx: &mut PgConnection,
    mut documents: Vec<(
      Uuid,
      &myoxus_domain::assistant_package::AssistantDocumentComponentSource,
      &String,
    )>,
    client_version: Option<u32>,
  ) -> AuthResult<()> {
    documents.sort_by_key(|(id, _, _)| *id);
    let ids = documents.iter().map(|(id, _, _)| *id).collect::<Vec<_>>();
    let catalog_ids: Vec<Uuid> =
      sqlx::query_scalar("SELECT DISTINCT template_id FROM template_revisions WHERE id=ANY($1) ORDER BY template_id")
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    for catalog in catalog_ids {
      sqlx::query("SELECT id FROM template_catalog_entries WHERE id=$1 FOR SHARE")
        .bind(catalog)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    for (revision_id, source, revision_digest) in documents {
      // Server-admitted component pins, not standalone publication, authorize
      // native setup. Retained components may never have had a Library export.
      let row = sqlx::query("SELECT r.version,r.state,(r.bundle_blob_id IS NOT NULL AND r.checksum IS NOT NULL) AS available,c.slug,c.status,c.min_client_version FROM template_revisions r JOIN template_catalog_entries c ON c.id=r.template_id WHERE r.id=$1 FOR SHARE OF r")
        .bind(revision_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
        .ok_or_else(|| AuthError::NotFound("accepted document source".into()))?;
      let minimum: i32 = row.try_get("min_client_version").map_err(Self::map_db_err)?;
      if row.get::<String, _>("version") != source.version
        || row.get::<String, _>("slug") != source.template_id
        || row.get::<String, _>("status") != "active"
        || !row.get::<bool, _>("available")
        || !matches!(row.get::<String, _>("state").as_str(), "published" | "deprecated")
        || crate::template_registry::locked_project_source_digest(tx, revision_id).await? != *revision_digest
        || client_version.is_none_or(|version| version == 0 || i64::from(version) < i64::from(minimum))
      {
        return Err(AuthError::InvalidInput(
          "accepted document source is unavailable".into(),
        ));
      }
    }
    Ok(())
  }
  pub(crate) async fn project_request_lock(
    tx: &mut PgConnection,
    actor: Uuid,
    operation: myoxus_application::workspace::StarterOperation,
    request: Uuid,
  ) -> AuthResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
      .bind(format!("starter:{}:{actor}:{request}", operation.as_str()))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }
  pub(super) async fn read_project_starter(
    &self,
    actor: Uuid,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: Uuid,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> myoxus_application::workspace::ProjectStarterResult<Option<myoxus_application::workspace::AcceptedProjectStarter>>
  {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Fingerprint/target-scope conflict belongs to the actor's accepted key,
    // before any target lookup can turn changed input into Gone/denial.
    sqlx::query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE")
      .bind(actor)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    if let Some(expected) = fingerprint {
      if let Some((stored,scope))=sqlx::query_as::<_,(String,Uuid)>("SELECT fingerprint,workspace_id FROM workspace_starter_applications WHERE actor_id=$1 AND operation=$3 AND request_id=$2")
        .bind(actor).bind(request).bind(operation.as_str()).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)? {
        if stored!=expected || scope!=workspace {return Err(myoxus_application::workspace::ProjectStarterError::Conflict)}
      }
    }
    Self::project_authority(
      &mut tx,
      actor,
      workspace,
      myoxus_domain::permission::WorkspaceAction::Read,
    )
    .await?;
    let result = Self::project_receipt(&mut tx, actor, operation, workspace, request, fingerprint).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result)
  }
  pub(super) async fn insert_project_starter(
    &self,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
    fingerprint: &str,
    plan: myoxus_domain::assistant_package::AssistantPreparedProject,
    admission: myoxus_application::workspace::ProjectStarterAdmission,
  ) -> myoxus_application::workspace::ProjectStarterResult<myoxus_application::workspace::AcceptedProjectStarter> {
    use myoxus_application::workspace::*;
    if request.is_nil() || plan.actor_id != actor || plan.workspace_id != Some(workspace) {
      return Err(ProjectStarterError::Conflict);
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::project_authority(
      &mut tx,
      actor,
      workspace,
      myoxus_domain::permission::WorkspaceAction::CreateDoc,
    )
    .await?;
    Self::project_request_lock(
      &mut tx,
      actor,
      myoxus_application::workspace::StarterOperation::CreateProject,
      request,
    )
    .await?;
    if let Some(existing) = Self::project_receipt(
      &mut tx,
      actor,
      myoxus_application::workspace::StarterOperation::CreateProject,
      workspace,
      request,
      Some(fingerprint),
    )
    .await?
    {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(existing);
    }
    Self::project_members(&mut tx, workspace, &plan).await?;
    let ids = Self::reserve_project_ids(&plan);
    Self::lock_project_sources(&mut tx, &plan).await?;
    sqlx::query("INSERT INTO workspace_starter_applications(actor_id,operation,request_id,fingerprint,package_id,package_version,package_digest,workspace_id,name,assistance_mode,project_plan,project_result_ids,project_admission,project_state,project_progress) VALUES($1,'create_project',$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11,'accepted',$12)")
      .bind(actor).bind(request).bind(fingerprint).bind(&plan.package.id).bind(&plan.package.version).bind(&plan.package.digest)
      .bind(workspace).bind(&plan.title).bind(serde_json::to_value(&plan).map_err(|e|AuthError::Storage(e.to_string()))?)
      .bind(serde_json::to_value(&ids).map_err(|e|AuthError::Storage(e.to_string()))?)
      .bind(serde_json::to_value(&admission).map_err(|e|AuthError::Storage(e.to_string()))?)
      .bind(serde_json::to_value(ProjectStarterProgress::default()).map_err(|e|AuthError::Storage(e.to_string()))?)
      .execute(&mut *tx).await.map_err(Self::map_db_err)?;
    let accepted = Self::project_receipt(
      &mut tx,
      actor,
      myoxus_application::workspace::StarterOperation::CreateProject,
      workspace,
      request,
      Some(fingerprint),
    )
    .await?
    .expect("inserted accepted Project");
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(accepted)
  }
  pub(super) async fn commit_project_starter(
    &self,
    actor: Uuid,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: Uuid,
    request: Uuid,
    fingerprint: &str,
    admission: myoxus_application::workspace::ProjectStarterAdmission,
    review: myoxus_domain::assistant_package::AssistantPreparedProject,
    state: myoxus_domain::database::DatabaseInitialState,
  ) -> myoxus_application::workspace::ProjectStarterResult<(
    myoxus_application::workspace::AcceptedProjectStarter,
    myoxus_domain::database::DatabaseRecord,
  )> {
    use myoxus_application::workspace::*;
    use myoxus_domain::database::DatabaseDefinitionRepository;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::project_authority(
      &mut tx,
      actor,
      workspace,
      myoxus_domain::permission::WorkspaceAction::CreateDoc,
    )
    .await?;
    Self::project_request_lock(&mut tx, actor, operation, request).await?;
    let mut receipt = Self::project_receipt(&mut tx, actor, operation, workspace, request, Some(fingerprint))
      .await?
      .ok_or(ProjectStarterError::Conflict)?;
    if receipt.plan.workspace_id.is_none() {
      if operation != StarterOperation::CreateWorkspace
        || review.workspace_id != Some(workspace)
        || review.actor_id != actor
        || review.package != receipt.plan.package
        || serde_json::to_value(&review.answers).map_err(|error| AuthError::Storage(error.to_string()))?
          != serde_json::to_value(&receipt.plan.answers).map_err(|error| AuthError::Storage(error.to_string()))?
        || review.locale != receipt.plan.locale
        || review.title != receipt.plan.title
        || review.description != receipt.plan.description
        || review.documents.len() != receipt.plan.document_metadata.len()
        || receipt
          .plan
          .document_metadata
          .iter()
          .zip(&review.documents)
          .any(|(metadata, document)| {
            metadata.source != document.source
              || metadata.source_revision_id != document.source_revision_id
              || metadata.source_revision_digest != document.source_revision_digest
              || metadata.locale != document.locale
              || metadata.variables != document.variables
              || metadata.folder != document.folder
          })
      {
        return Err(ProjectStarterError::Conflict);
      }
      let bound = sqlx::query("UPDATE workspace_starter_applications SET project_plan=$4 WHERE actor_id=$1 AND operation=$2 AND request_id=$3 AND project_plan IS NULL AND project_state='accepted'")
        .bind(actor).bind(operation.as_str()).bind(request).bind(serde_json::to_value(&review).map_err(|error|AuthError::Storage(error.to_string()))?)
        .execute(&mut *tx).await.map_err(Self::map_db_err)?;
      if bound.rows_affected() != 1 {
        return Err(ProjectStarterError::Conflict);
      }
      receipt.plan = review;
    }
    if receipt.progress.project_created || receipt.state == ProjectStarterState::Complete {
      if receipt.state == ProjectStarterState::Accepted {
        let row = sqlx::query(
          "SELECT managed_installation,deleted_at FROM workspace_databases WHERE id=$1 AND workspace_id=$2 FOR SHARE",
        )
        .bind(receipt.ids.database_id)
        .bind(workspace)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        let installation: Option<serde_json::Value> = row.get("managed_installation");
        let installation: myoxus_domain::database::DatabaseManagedSchemaInstallation =
          serde_json::from_value(installation.ok_or(ProjectStarterError::Conflict)?)
            .map_err(|_| AuthError::Storage("invalid Project managed installation".into()))?;
        if row
          .get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
          .is_some()
          || installation.template_id != admission.template_id
          || installation.template_version != admission.version
          || installation.template_digest != admission.digest
          || installation.variant.priority != admission.variant.priority
          || installation.variant.complexity != admission.variant.complexity
          || installation.variant.structure != admission.variant.structure
          || installation.readiness != myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready
        {
          return Err(ProjectStarterError::Conflict);
        }
        sqlx::query("UPDATE workspace_starter_applications SET project_admission=$3 WHERE actor_id=$1 AND operation=$4 AND request_id=$2 AND project_state='accepted'")
          .bind(actor).bind(request).bind(serde_json::to_value(&admission).map_err(|error| AuthError::Storage(error.to_string()))?).bind(operation.as_str())
          .execute(&mut *tx).await.map_err(Self::map_db_err)?;
        receipt.admission = admission;
      }
      tx.commit().await.map_err(Self::map_db_err)?;
      let record =
        crate::workspace_database::PgDatabaseRepository::new(self.pool.clone(), self.database_templates.clone())
          .get_database(receipt.ids.database_id)
          .await
          .map_err(|error| AuthError::Storage(error.to_string()))?
          .ok_or(ProjectStarterError::Gone {
            database_id: receipt.ids.database_id,
          })?;
      return Ok((receipt, record));
    }
    if receipt.state != ProjectStarterState::Accepted {
      return Err(ProjectStarterError::Conflict);
    }
    if sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspace_databases WHERE id=$1 FOR UPDATE")
      .bind(receipt.ids.database_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .is_some()
    {
      return Err(ProjectStarterError::Conflict);
    }
    let installed = state
      .database
      .managed_installation
      .as_ref()
      .ok_or(ProjectStarterError::Conflict)?;
    if state.database.id != receipt.ids.database_id
      || state.database.workspace_id != workspace
      || state.database.system_role.is_some()
      || installed.template_id != admission.template_id
      || installed.template_version != admission.version
      || installed.template_digest != admission.digest
      || installed.variant.priority != admission.variant.priority
      || installed.variant.complexity != admission.variant.complexity
      || installed.variant.structure != admission.variant.structure
      || self.database_templates.current_source(&admission.template_id)
        != Some((admission.version.as_str(), admission.digest.as_str()))
    {
      return Err(ProjectStarterError::Conflict);
    }
    for (key, id) in &receipt.ids.scaffold_rows {
      let planned = receipt
        .plan
        .setup
        .scaffold
        .iter()
        .find(|row| row.id == *key)
        .ok_or(ProjectStarterError::Conflict)?;
      let expected_kind = match planned.kind {
        myoxus_domain::assistant_package::AssistantProjectScaffoldKind::Phase => {
          myoxus_domain::database::DatabaseRowKind::Phase
        }
        myoxus_domain::assistant_package::AssistantProjectScaffoldKind::Milestone => {
          myoxus_domain::database::DatabaseRowKind::Milestone
        }
      };
      if !state
        .rows
        .iter()
        .any(|row| row.row.id == *id && row.row.row_kind == expected_kind)
      {
        return Err(ProjectStarterError::Conflict);
      }
    }
    Self::project_members(&mut tx, workspace, &receipt.plan).await?;
    Self::lock_project_sources(&mut tx, &receipt.plan).await?;
    crate::workspace_database::PgDatabaseRepository::capture_catalog_admission(&mut tx, &self.database_templates)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let record = crate::workspace_database::PgDatabaseRepository::insert_project_starter_in_tx(&mut tx, state, actor)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    receipt.progress.project_created = true;
    receipt.progress.placement_complete = receipt.ids.project_entry_id.is_none() && receipt.ids.documents.is_empty();
    receipt.state = if receipt.progress.placement_complete {
      ProjectStarterState::Complete
    } else {
      ProjectStarterState::Accepted
    };
    let acknowledged=sqlx::query("UPDATE workspace_starter_applications SET project_state=$4,project_admission=$3,project_progress=$5 WHERE actor_id=$1 AND operation=$6 AND request_id=$2 AND project_state='accepted'")
      .bind(actor).bind(request).bind(serde_json::to_value(&admission).map_err(|e|AuthError::Storage(e.to_string()))?)
      .bind(if receipt.state == ProjectStarterState::Complete { "complete" } else { "accepted" })
      .bind(serde_json::to_value(&receipt.progress).map_err(|e|AuthError::Storage(e.to_string()))?).bind(operation.as_str())
      .execute(&mut *tx).await.map_err(Self::map_db_err)?;
    if acknowledged.rows_affected() != 1 {
      return Err(ProjectStarterError::Conflict);
    }
    receipt.admission = admission;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok((receipt, record))
  }
  pub(super) async fn stop_accepted_project(
    &self,
    actor: Uuid,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: Uuid,
    request: Uuid,
  ) -> myoxus_application::workspace::ProjectStarterResult<myoxus_application::workspace::AcceptedProjectStarter> {
    use myoxus_application::workspace::*;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::project_authority(
      &mut tx,
      actor,
      workspace,
      myoxus_domain::permission::WorkspaceAction::CreateDoc,
    )
    .await?;
    Self::project_request_lock(&mut tx, actor, operation, request).await?;
    let mut receipt = Self::project_receipt(&mut tx, actor, operation, workspace, request, None)
      .await?
      .ok_or(ProjectStarterError::Conflict)?;
    if receipt.state == ProjectStarterState::Accepted {
      sqlx::query("UPDATE workspace_starter_applications SET project_state='stopped' WHERE actor_id=$1 AND operation=$3 AND request_id=$2")
        .bind(actor).bind(request).bind(operation.as_str()).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      receipt.state = ProjectStarterState::Stopped;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(receipt)
  }
}

impl SqlxWorkspaceStore {
  pub(crate) fn setup_from_row(
    row: &sqlx::postgres::PgRow,
  ) -> AuthResult<Option<myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup>> {
    use myoxus_application::workspace::assistant_packages::*;
    use myoxus_domain::{assistant_package::*, workspace_automation::WorkspaceSetupResult};
    let Some(outer) = row
      .try_get::<Option<serde_json::Value>, _>("workspace_plan")
      .map_err(Self::map_db_err)?
    else {
      return Ok(None);
    };
    let Some(original) = outer.get("setup") else {
      return Ok(None);
    };
    let invalid = || AuthError::Storage("invalid accepted Workspace setup".into());
    let original: AssistantPreparedWorkspaceSetup = serde_json::from_value(original.clone()).map_err(|_| invalid())?;
    let plan: Option<AssistantPreparedWorkspaceSetup> = row
      .try_get::<Option<serde_json::Value>, _>("setup_plan")
      .map_err(Self::map_db_err)?
      .map(serde_json::from_value)
      .transpose()
      .map_err(|_| invalid())?;
    let reservations: Vec<WorkspaceSetupReservation> =
      serde_json::from_value(row.try_get("setup_result_ids").map_err(Self::map_db_err)?).map_err(|_| invalid())?;
    let mut progress: WorkspaceSetupProgress =
      serde_json::from_value(row.try_get("setup_progress").map_err(Self::map_db_err)?).map_err(|_| invalid())?;
    let document_progress: myoxus_application::workspace::ProjectStarterProgress =
      serde_json::from_value(row.try_get("project_progress").map_err(Self::map_db_err)?).map_err(|_| invalid())?;
    let documents: serde_json::Value = row.try_get("project_result_ids").map_err(Self::map_db_err)?;
    let actor = row.try_get("actor_id").map_err(Self::map_db_err)?;
    let workspace = row.try_get("workspace_id").map_err(Self::map_db_err)?;
    let state = serde_json::from_value(serde_json::Value::String(
      row.try_get("project_state").map_err(Self::map_db_err)?,
    ))
    .map_err(|_| invalid())?;
    let run_id = row
      .try_get::<Option<Uuid>, _>("automation_run_id")
      .map_err(Self::map_db_err)?
      .ok_or_else(|| invalid())?;
    if original.actor_id != actor
      || original.workspace_id.is_some()
      || document_progress.project_created
      || reservations.len() != original.components.len()
    {
      return Err(invalid());
    }
    let mut ids = std::collections::BTreeSet::new();
    let mut names = std::collections::BTreeSet::new();
    for reserved in &reservations {
      if reserved.result_id.is_nil()
        || reserved.entry_id.is_empty()
        || !ids.insert(reserved.result_id)
        || !names.insert(&reserved.component_id)
        || !original
          .components
          .iter()
          .any(|component| component.id == reserved.component_id)
      {
        return Err(invalid());
      }
    }
    for (component, created) in &document_progress.documents {
      if !reservations
        .iter()
        .any(|reserved| reserved.component_id == *component && reserved.result_id == created.doc_id)
        || !original
          .document_metadata
          .iter()
          .any(|document| document.source.component_id == *component)
        || created.document_revision <= 0
        || created.root_revision <= 0
        || created.external_id.is_empty()
      {
        return Err(invalid());
      }
      progress.results.insert(
        component.clone(),
        WorkspaceSetupResult::Document {
          document_id: created.doc_id,
        },
      );
    }
    for (component, result) in &progress.results {
      let reserved = reservations
        .iter()
        .find(|reserved| reserved.component_id == *component)
        .ok_or_else(|| invalid())?;
      let native = original
        .components
        .iter()
        .find(|native| native.id == *component)
        .ok_or_else(|| invalid())?;
      if !matches!((&native.action,result),
        (AssistantNativeAction::CreateDatabaseFromDefinition{..},WorkspaceSetupResult::Database{database_id}) if *database_id==reserved.result_id)
        && !matches!((&native.action,result),(AssistantNativeAction::CreateWorkingDocument{..},WorkspaceSetupResult::Document{document_id}) if *document_id==reserved.result_id)
        && !matches!((&native.action,result),(AssistantNativeAction::PlaceNativeLink{..},WorkspaceSetupResult::NativeLink{component_id,entry_id}) if *component_id==*component&&*entry_id==reserved.entry_id)
      {
        return Err(invalid());
      }
    }
    if let Some(bound) = &plan {
      let mut expected = original.clone();
      expected.workspace_id = Some(workspace);
      expected.documents = bound.documents.clone();
      expected.execution_available = bound.execution_available;
      if serde_json::to_value(expected).map_err(|_| invalid())? != serde_json::to_value(bound).map_err(|_| invalid())? {
        return Err(invalid());
      }
      for document in &bound.documents {
        if !original.document_metadata.iter().any(|metadata| {
          metadata.source == document.source
            && metadata.source_revision_id == document.source_revision_id
            && metadata.source_revision_digest == document.source_revision_digest
            && metadata.locale == document.locale
            && metadata.title == document.title
            && metadata.variables == document.variables
            && metadata.folder == document.folder
        }) {
          return Err(invalid());
        }
      }
    }
    if (state == myoxus_application::workspace::ProjectStarterState::Complete) != document_progress.placement_complete
      || (!document_progress.documents.is_empty() && !document_progress.folder_ready)
    {
      return Err(invalid());
    }
    for (component, result) in &progress.results {
      if let WorkspaceSetupResult::Document { document_id } = result {
        if !document_progress
          .documents
          .get(component)
          .is_some_and(|created| created.doc_id == *document_id)
        {
          return Err(invalid());
        }
      }
    }
    progress.folder_ready = document_progress.folder_ready;
    progress.complete = document_progress.placement_complete;
    Ok(Some(AcceptedWorkspaceSetup {
      actor_id: actor,
      workspace_id: workspace,
      request_id: row.try_get("request_id").map_err(Self::map_db_err)?,
      fingerprint: row.try_get("fingerprint").map_err(Self::map_db_err)?,
      original,
      plan,
      reservations,
      progress,
      state,
      run_id,
      document_progress,
      folder_id: documents
        .get("folderId")
        .and_then(serde_json::Value::as_str)
        .map(String::from),
    }))
  }
  pub(crate) async fn setup_receipt(
    tx: &mut PgConnection,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> WorkspaceStarterResult<Option<myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup>> {
    let Some(row)=sqlx::query("SELECT * FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 FOR UPDATE").bind(actor).bind(request).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)? else{return Ok(None)};
    if row.try_get::<Uuid, _>("workspace_id").map_err(Self::map_db_err)? != workspace
      || fingerprint.is_some_and(|value| row.get::<String, _>("fingerprint") != value)
    {
      return Err(WorkspaceStarterError::Conflict);
    }
    Ok(Self::setup_from_row(&row)?)
  }
}

impl SqlxWorkspaceStore {
  pub(super) async fn bind_setup(
    &self,
    accepted: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
    plan: myoxus_domain::assistant_package::AssistantPreparedWorkspaceSetup,
  ) -> WorkspaceStarterResult<myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::project_authority(
      &mut tx,
      accepted.actor_id,
      accepted.workspace_id,
      myoxus_domain::permission::WorkspaceAction::CreateDoc,
    )
    .await?;
    let current = Self::setup_receipt(
      &mut tx,
      accepted.actor_id,
      accepted.workspace_id,
      accepted.request_id,
      Some(&accepted.fingerprint),
    )
    .await?
    .ok_or(WorkspaceStarterError::Conflict)?;
    if current.state != myoxus_application::workspace::ProjectStarterState::Accepted {
      return Err(WorkspaceStarterError::Conflict);
    }
    let saved:bool=sqlx::query_scalar("SELECT assistance_saved_at IS NOT NULL FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2")
      .bind(accepted.actor_id).bind(accepted.request_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
    if !saved {
      return Err(AuthError::InvalidInput("Workspace assistance acknowledgement pending".into()).into());
    }
    // The original metadata, selection and authored values never change at
    // binding; only the real scope and full native content preflight are added.
    let mut expected = current.original.clone();
    expected.workspace_id = Some(current.workspace_id);
    expected.documents = plan.documents.clone();
    expected.execution_available = plan.execution_available;
    if serde_json::to_value(expected).map_err(|error| AuthError::Storage(error.to_string()))?
      != serde_json::to_value(&plan).map_err(|error| AuthError::Storage(error.to_string()))?
    {
      return Err(WorkspaceStarterError::Conflict);
    }
    Self::lock_source_pins(
      &mut tx,
      plan
        .documents
        .iter()
        .filter(|doc| {
          !current
            .document_progress
            .documents
            .contains_key(&doc.source.component_id)
        })
        .map(|doc| (doc.source_revision_id, &doc.source, &doc.source_revision_digest))
        .collect(),
      Some(plan.client_version),
    )
    .await?;
    sqlx::query("UPDATE workspace_starter_applications SET setup_plan=$3 WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 AND project_state='accepted'")
      .bind(current.actor_id).bind(current.request_id).bind(serde_json::to_value(plan).map_err(|error|AuthError::Storage(error.to_string()))?).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    let updated = Self::setup_receipt(
      &mut tx,
      current.actor_id,
      current.workspace_id,
      current.request_id,
      Some(&current.fingerprint),
    )
    .await?
    .ok_or(WorkspaceStarterError::Conflict)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(updated)
  }
  /// Replayed results are never adopted, reconstructed or treated as grants.
  /// The current workspace Editor floor supplies native read authority; locks
  /// retain the exact live result identities through the next effect commit.
  pub(crate) async fn setup_result_fence(
    tx: &mut PgConnection,
    receipt: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
  ) -> AuthResult<()> {
    use myoxus_domain::workspace_automation::WorkspaceSetupResult;
    let mut databases = receipt
      .progress
      .results
      .values()
      .filter_map(|result| match result {
        WorkspaceSetupResult::Database { database_id } => Some(*database_id),
        _ => None,
      })
      .collect::<Vec<_>>();
    databases.sort();
    databases.dedup();
    for id in databases {
      sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND system_role IS NULL AND managed_installation IS NULL FOR SHARE")
        .bind(id).bind(receipt.workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or_else(||AuthError::InvalidInput("accepted Generic result unavailable".into()))?;
      // Plain Generic copies have no profile row. Native readers interpret
      // absence as Generic; lock only an existing optional profile after its root.
      let profile: Option<String> =
        sqlx::query_scalar("SELECT profile_kind FROM database_profiles WHERE database_id=$1 FOR SHARE")
          .bind(id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
      if profile.as_deref().is_some_and(|kind| kind != "generic") {
        return Err(AuthError::InvalidInput("accepted Generic result changed".into()));
      }
    }
    // Retain the canonical lifecycle document set before locking Doc rows.
    // NOWAIT avoids an inverted wait against an ordinary writer that already
    // owns a subset; contention remains a transient, side-effect-free attempt.
    let mut doc_set = std::collections::BTreeSet::from([receipt.workspace_id]);
    doc_set.extend(receipt.original.document_metadata.iter().filter_map(|document| {
      receipt
        .reservations
        .iter()
        .find(|reserved| reserved.component_id == document.source.component_id)
        .map(|reserved| reserved.result_id)
    }));
    let organizer: Option<Uuid> = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
      .bind(receipt.workspace_id)
      .bind(format!("db${}$folders", receipt.workspace_id))
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    doc_set.extend(organizer);
    for id in doc_set {
      let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(crate::document_version::edit_capture_state::lock_key(
          receipt.workspace_id,
          id,
        ))
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      if !locked {
        return Err(AuthError::Storage("Workspace setup document writer is busy".into()));
      }
    }
    let mut documents = receipt.document_progress.documents.values().collect::<Vec<_>>();
    documents.sort_by_key(|document| document.doc_id);
    for document in documents {
      let actual:Option<String>=sqlx::query_scalar("SELECT external_id FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT blocked AND NOT is_workspace_root FOR SHARE NOWAIT")
        .bind(document.doc_id).bind(receipt.workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
      if actual.as_deref() != Some(document.external_id.as_str()) {
        return Err(AuthError::InvalidInput("accepted document result unavailable".into()));
      }
    }
    Ok(())
  }
  pub(super) async fn publish_setup_database(
    &self,
    accepted: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
    component: &str,
    state: myoxus_domain::database::DatabaseInitialState,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> WorkspaceStarterResult<()> {
    use myoxus_domain::workspace_automation::*;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let stage = ContextDocumentWorkflowStage::CreateDatabaseFromDefinition {
      component: component.into(),
    };
    let prior = crate::workflow_runtime::effects::lock_setup_receipt_effect(
      &mut tx,
      &fence,
      &stage,
      accepted.actor_id,
      accepted.workspace_id,
      accepted.request_id,
      &accepted.fingerprint,
      None,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    let mut actual = Self::setup_receipt(
      &mut tx,
      accepted.actor_id,
      accepted.workspace_id,
      accepted.request_id,
      Some(&accepted.fingerprint),
    )
    .await?
    .ok_or(WorkspaceStarterError::Conflict)?;
    let reserved = actual
      .reservations
      .iter()
      .find(|reserved| reserved.component_id == component)
      .ok_or(WorkspaceStarterError::Conflict)?;
    if prior.is_some() {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(());
    }
    let plan = actual.plan.as_ref().ok_or(WorkspaceStarterError::Conflict)?;
    if !plan
      .definitions
      .iter()
      .any(|definition| definition.component_id == component)
      || state.database.id != reserved.result_id
      || state.database.workspace_id != actual.workspace_id
      || state.database.profile_kind != myoxus_domain::database::DatabaseProfileKind::Generic
      || state.database.managed_installation.is_some()
      || state.database.system_role.is_some()
    {
      return Err(WorkspaceStarterError::Conflict);
    }
    crate::workspace_database::PgDatabaseRepository::insert_initial_state_in_tx(&mut tx, state, None)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let result = WorkspaceSetupResult::Database {
      database_id: reserved.result_id,
    };
    actual.progress.results.insert(component.into(), result.clone());
    sqlx::query("UPDATE workspace_starter_applications SET setup_progress=$3 WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 AND project_state='accepted'")
      .bind(actual.actor_id).bind(actual.request_id).bind(serde_json::to_value(&actual.progress).map_err(|error|AuthError::Storage(error.to_string()))?).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    crate::workflow_runtime::effects::acknowledge_runtime_effect(
      &mut tx,
      &fence,
      serde_json::to_value(WorkspaceSetupStageResult::Component {
        component_id: component.into(),
        result,
      })
      .map_err(|error| AuthError::Storage(error.to_string()))?,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }
  pub(super) async fn finish_setup(
    &self,
    accepted: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> WorkspaceStarterResult<()> {
    use myoxus_domain::workspace_automation::*;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if crate::workflow_runtime::effects::lock_setup_receipt_effect(
      &mut tx,
      &fence,
      &ContextDocumentWorkflowStage::Complete,
      accepted.actor_id,
      accepted.workspace_id,
      accepted.request_id,
      &accepted.fingerprint,
      None,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?
    .is_some()
    {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(());
    }
    let actual = Self::setup_receipt(
      &mut tx,
      accepted.actor_id,
      accepted.workspace_id,
      accepted.request_id,
      Some(&accepted.fingerprint),
    )
    .await?
    .ok_or(WorkspaceStarterError::Conflict)?;
    if actual
      .original
      .components
      .iter()
      .any(|component| !actual.progress.results.contains_key(&component.id))
    {
      return Err(WorkspaceStarterError::Conflict);
    }
    sqlx::query("UPDATE workspace_starter_applications SET project_state='complete',project_progress=jsonb_set(project_progress,'{placementComplete}','true'::jsonb) WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 AND project_state='accepted'")
      .bind(actual.actor_id).bind(actual.request_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    crate::workflow_runtime::effects::acknowledge_runtime_effect(
      &mut tx,
      &fence,
      serde_json::to_value(WorkspaceSetupStageResult::Complete)
        .map_err(|error| AuthError::Storage(error.to_string()))?,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }
}
