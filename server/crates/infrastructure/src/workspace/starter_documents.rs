// SPDX-License-Identifier: AGPL-3.0-or-later
//! The prepare_documents branch of the existing native starter ledger.
use super::*;
use myoxus_application::workspace::*;
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::{DatabaseManagedSchemaInstallation, DatabaseManagedSchemaReadiness};
use std::collections::BTreeSet;
impl SqlxWorkspaceStore {
  pub(crate) async fn context_receipt(
    tx: &mut PgConnection,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> ContextDocumentStarterResult<Option<AcceptedContextDocuments>> {
    let Some(row)=sqlx::query("SELECT * FROM workspace_starter_applications WHERE actor_id=$1 AND operation='prepare_documents' AND request_id=$2 FOR UPDATE")
      .bind(actor).bind(request).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)? else{return Ok(None)};
    let stored: String = row.try_get("fingerprint").map_err(Self::map_db_err)?;
    let scope: Uuid = row.try_get("workspace_id").map_err(Self::map_db_err)?;
    if scope != workspace || fingerprint.is_some_and(|value| value != stored) {
      return Err(ProjectStarterError::Conflict);
    }
    let parse = |key: &str| -> AuthResult<serde_json::Value> { row.try_get(key).map_err(Self::map_db_err) };
    let invalid = |_| AuthError::Storage("invalid contextual document receipt".into());
    let accepted = AcceptedContextDocuments {
      run_id: row.try_get("automation_run_id").map_err(Self::map_db_err)?,
      actor_id: actor,
      workspace_id: workspace,
      request_id: request,
      fingerprint: stored,
      plan: serde_json::from_value(parse("project_plan")?).map_err(invalid)?,
      ids: serde_json::from_value(parse("project_result_ids")?).map_err(invalid)?,
      admission: serde_json::from_value(parse("project_admission")?).map_err(invalid)?,
      progress: serde_json::from_value(parse("project_progress")?).map_err(invalid)?,
      state: serde_json::from_value(serde_json::Value::String(
        row.try_get("project_state").map_err(Self::map_db_err)?,
      ))
      .map_err(invalid)?,
    };
    let mut components = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut entries = BTreeSet::new();
    if accepted.plan.actor_id != actor
      || accepted.plan.workspace_id != workspace
      || accepted.ids.documents.len() != accepted.plan.documents.len()
      || accepted.plan.documents.is_empty()
      || accepted.progress.project_created
      || accepted.ids.folder_id.is_empty()
      || (accepted.state == ProjectStarterState::Complete && !accepted.progress.placement_complete)
    {
      return Err(AuthError::Storage("invalid contextual document frontier".into()).into());
    }
    for reserved in &accepted.ids.documents {
      if !components.insert(&reserved.component_id)
        || !ids.insert(reserved.doc_id)
        || !entries.insert(&reserved.entry_id)
        || reserved.doc_id.is_nil()
        || reserved.entry_id.is_empty()
        || !accepted
          .plan
          .documents
          .iter()
          .any(|doc| doc.source.component_id == reserved.component_id)
      {
        return Err(AuthError::Storage("invalid contextual document reservation".into()).into());
      }
    }
    for (key, result) in &accepted.progress.documents {
      if !accepted
        .ids
        .documents
        .iter()
        .any(|ids| ids.component_id == *key && ids.doc_id == result.doc_id)
        || result.external_id != result.doc_id.to_string()
        || result.document_revision <= 0
        || result.root_revision <= 0
        || !accepted.progress.folder_ready
      {
        return Err(AuthError::Storage("invalid contextual document acknowledgement".into()).into());
      }
    }
    if accepted.progress.placement_complete
      && accepted.ids.documents.iter().any(|ids| {
        !accepted
          .progress
          .documents
          .get(&ids.component_id)
          .is_some_and(|result| result.placed)
      })
    {
      return Err(AuthError::Storage("incomplete contextual document placement".into()).into());
    }
    Ok(Some(accepted))
  }
  pub(crate) async fn context_target_fence(
    tx: &mut PgConnection,
    workspace: Uuid,
    target: &ContextDocumentTarget,
    expected: &DatabaseManagedSchemaInstallation,
  ) -> AuthResult<()> {
    let row=sqlx::query("SELECT d.managed_installation FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id WHERE d.id=$1 AND d.workspace_id=$2 AND d.deleted_at IS NULL AND p.profile_kind='project' AND (d.system_role IS NULL OR d.system_role='workspace_tasks') FOR SHARE OF d,p")
      .bind(target.database_id).bind(workspace).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or_else(||AuthError::NotFound("Task container".into()))?;
    let actual: Option<serde_json::Value> = row.try_get("managed_installation").map_err(Self::map_db_err)?;
    // Schema revision is part of the authoritative managed_installation JSON,
    // alongside exact source pins and bindings; there is no separate SQL column.
    if expected.readiness != DatabaseManagedSchemaReadiness::Ready
      || actual.as_ref()
        != Some(&serde_json::to_value(expected).map_err(|error| AuthError::Storage(error.to_string()))?)
    {
      return Err(AuthError::InvalidInput("Task container admission changed".into()));
    }
    if let Some(task) = target.task_id {
      sqlx::query("SELECT id FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL FOR SHARE")
        .bind(task).bind(target.database_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or_else(||AuthError::NotFound("context Task".into()))?;
    }
    Ok(())
  }
  pub(super) async fn read_context_documents(
    &self,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> ContextDocumentStarterResult<Option<AcceptedContextDocuments>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE")
      .bind(actor)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    if let Some(expected) = fingerprint {
      if let Some((stored,scope))=sqlx::query_as::<_,(String,Uuid)>("SELECT fingerprint,workspace_id FROM workspace_starter_applications WHERE actor_id=$1 AND operation='prepare_documents' AND request_id=$2")
        .bind(actor).bind(request).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)? {
        if stored!=expected||scope!=workspace{return Err(ProjectStarterError::Conflict)}
      }
    }
    Self::project_authority(
      &mut tx,
      actor,
      workspace,
      myoxus_domain::permission::WorkspaceAction::Read,
    )
    .await?;
    let result = Self::context_receipt(&mut tx, actor, workspace, request, fingerprint).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result)
  }
  pub(super) async fn insert_context_documents(
    &self,
    actor: Uuid,
    workspace: Uuid,
    request: Uuid,
    fingerprint: &str,
    plan: AssistantPreparedContextDocuments,
    admission: ContextDocumentAdmission,
    definition: myoxus_domain::workspace_automation::AcceptedAutomationDefinition,
  ) -> ContextDocumentStarterResult<AcceptedContextDocuments> {
    if request.is_nil()
      || plan.actor_id != actor
      || plan.workspace_id != workspace
      || plan.documents.is_empty()
      || plan.documents.len() > 64
      || plan.client_version == 0
      || admission.effects_digest
        != myoxus_application::workspace::assistant_packages::context_documents_admission(&plan).effects_digest
    {
      return Err(ProjectStarterError::Conflict);
    }
    let compiled =
      myoxus_application::workspace_automation::workflows::compile_context_workflow(&plan, definition.policy.clone())
        .map_err(|_| ProjectStarterError::Conflict)?;
    if serde_json::to_value(&compiled).map_err(|error| AuthError::Storage(error.to_string()))?
      != serde_json::to_value(&definition).map_err(|error| AuthError::Storage(error.to_string()))?
    {
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
    Self::project_request_lock(&mut tx, actor, StarterOperation::PrepareDocuments, request).await?;
    if let Some(existing) = Self::context_receipt(&mut tx, actor, workspace, request, Some(fingerprint)).await? {
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(existing);
    }
    Self::context_target_fence(&mut tx, workspace, &plan.target, &admission.installation).await?;
    let ids = ContextDocumentStarterIds {
      documents: plan
        .documents
        .iter()
        .map(|doc| ProjectStarterDocumentIds {
          component_id: doc.source.component_id.clone(),
          doc_id: Uuid::new_v4(),
          entry_id: Uuid::new_v4().to_string(),
        })
        .collect(),
      folder_id: match &plan.folder {
        AssistantFolderDestination::Existing { id } => id.clone(),
        AssistantFolderDestination::New { .. } => Uuid::new_v4().to_string(),
      },
    };
    let accepted = AcceptedContextDocuments {
      run_id: Some(Uuid::new_v4()),
      actor_id: actor,
      workspace_id: workspace,
      request_id: request,
      fingerprint: fingerprint.into(),
      plan,
      ids,
      admission,
      state: ProjectStarterState::Accepted,
      progress: ProjectStarterProgress::default(),
    };
    Self::document_people(&mut tx, &accepted.document_receipt()).await?;
    Self::lock_document_sources(&mut tx, &accepted.document_receipt()).await?;
    sqlx::query("INSERT INTO workspace_starter_applications(actor_id,operation,request_id,fingerprint,package_id,package_version,package_digest,workspace_id,name,assistance_mode,project_plan,project_result_ids,project_admission,project_state,project_progress,automation_run_id) VALUES($1,'prepare_documents',$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11,'accepted',$12,$13)")
      .bind(actor).bind(request).bind(fingerprint).bind(&accepted.plan.package.id).bind(&accepted.plan.package.version).bind(&accepted.plan.package.digest).bind(workspace).bind(&accepted.plan.documents[0].title)
      .bind(serde_json::to_value(&accepted.plan).map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(serde_json::to_value(&accepted.ids).map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(serde_json::to_value(&accepted.admission).map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(serde_json::to_value(&accepted.progress).map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(accepted.run_id)
      .execute(&mut *tx).await.map_err(Self::map_db_err)?;
    let run_id = accepted.run_id.ok_or(ProjectStarterError::Conflict)?;
    let run = myoxus_domain::workspace_automation::AcceptedAutomationRun {
      recurring_task: None,
      workspace_setup: None,
      run_id,
      automation_id: None,
      workspace_id: workspace,
      actor_id: Some(actor),
      trigger: None,
      document_review: None,
      task_handover: None,
      task_maintenance: None,
      personal_rule: None,
      confirmed_request: Some(myoxus_domain::workspace_automation::AcceptedContextDocumentRequest {
        request_id: request,
        fingerprint: fingerprint.into(),
        target: accepted.plan.target.clone(),
      }),
      definition,
    };
    sqlx::query("INSERT INTO workspace_automation_runs(id,workspace_id,idempotency_key,status,queued_at,accepted_json,origin_kind,confirmed_actor_id,confirmed_operation,confirmed_request_id) VALUES($1,$2,$3,'queued',now(),$4,'confirmed_context_documents',$5,'prepare_documents',$6)")
      .bind(run_id).bind(workspace).bind(fingerprint)
      .bind(serde_json::to_value(&run).map_err(|error|AuthError::Storage(error.to_string()))?)
      .bind(actor).bind(request).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(accepted)
  }
  pub(super) async fn update_context_documents(
    &self,
    accepted: &AcceptedContextDocuments,
    admission: Option<ContextDocumentAdmission>,
    stop: bool,
  ) -> ContextDocumentStarterResult<AcceptedContextDocuments> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::project_authority(
      &mut tx,
      accepted.actor_id,
      accepted.workspace_id,
      myoxus_domain::permission::WorkspaceAction::CreateDoc,
    )
    .await?;
    Self::project_request_lock(
      &mut tx,
      accepted.actor_id,
      StarterOperation::PrepareDocuments,
      accepted.request_id,
    )
    .await?;
    let mut actual = Self::context_receipt(
      &mut tx,
      accepted.actor_id,
      accepted.workspace_id,
      accepted.request_id,
      Some(&accepted.fingerprint),
    )
    .await?
    .ok_or(ProjectStarterError::Conflict)?;
    if actual.state == ProjectStarterState::Accepted {
      if stop {
        actual.state = ProjectStarterState::Stopped
      } else if let Some(admission) = admission {
        Self::context_target_fence(
          &mut tx,
          actual.workspace_id,
          &actual.plan.target,
          &admission.installation,
        )
        .await?;
        Self::document_people(&mut tx, &actual.document_receipt()).await?;
        actual.admission = admission;
      }
      sqlx::query("UPDATE workspace_starter_applications SET project_state=$3,project_admission=$4 WHERE actor_id=$1 AND operation='prepare_documents' AND request_id=$2")
        .bind(actual.actor_id).bind(actual.request_id).bind(serde_json::to_value(actual.state).map_err(|error|AuthError::Storage(error.to_string()))?.as_str().ok_or(ProjectStarterError::Conflict)?)
        .bind(serde_json::to_value(&actual.admission).map_err(|error|AuthError::Storage(error.to_string()))?).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(actual)
  }
  pub(crate) async fn document_receipt(
    tx: &mut PgConnection,
    actor: Uuid,
    operation: StarterOperation,
    workspace: Uuid,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> ContextDocumentStarterResult<Option<StarterDocumentReceipt>> {
    if operation == StarterOperation::CreateWorkspace {
      if let Some(setup) = Self::setup_receipt(tx, actor, workspace, request, fingerprint)
        .await
        .map_err(|error| match error {
          WorkspaceStarterError::Auth(error) => ProjectStarterError::Auth(error),
          _ => ProjectStarterError::Conflict,
        })?
      {
        return Ok(Some(setup.document_receipt()));
      }
    }
    match operation {
      StarterOperation::PrepareDocuments => Ok(
        Self::context_receipt(tx, actor, workspace, request, fingerprint)
          .await?
          .map(|receipt| receipt.document_receipt()),
      ),
      _ => Ok(
        Self::project_receipt(tx, actor, operation, workspace, request, fingerprint)
          .await?
          .map(|receipt| receipt.document_receipt()),
      ),
    }
  }
  pub(crate) async fn document_people(tx: &mut PgConnection, receipt: &StarterDocumentReceipt) -> AuthResult<()> {
    let mut people = receipt.people.clone();
    people.sort();
    people.dedup();
    for person in people {
      sqlx::query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE")
      .bind(receipt.workspace_id).bind(person).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or(AuthError::ActionForbidden)?;
    }
    Ok(())
  }
  pub(crate) async fn lock_document_sources(tx: &mut PgConnection, receipt: &StarterDocumentReceipt) -> AuthResult<()> {
    Self::lock_source_pins(
      tx,
      receipt
        .documents
        .iter()
        .map(|doc| (doc.source_revision_id, &doc.source, &doc.source_revision_digest))
        .collect(),
      receipt.client_version,
    )
    .await
  }
  pub(crate) async fn document_admission_fence(
    tx: &mut PgConnection,
    receipt: &StarterDocumentReceipt,
    admission: &StarterDocumentAdmission,
  ) -> AuthResult<()> {
    match (&receipt.origin, admission) {
      (StarterDocumentOrigin::WorkspaceSetup { .. }, StarterDocumentAdmission::WorkspaceSetup) => Ok(()),
      (StarterDocumentOrigin::Project { database_id, .. }, StarterDocumentAdmission::ProjectSetup { installation }) => {
        let actual:Option<serde_json::Value>=sqlx::query_scalar::<_,Option<serde_json::Value>>("SELECT managed_installation FROM workspace_databases WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND system_role IS NULL FOR SHARE")
          .bind(database_id).bind(receipt.workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.flatten();
        if actual.as_ref()
          != Some(&serde_json::to_value(installation).map_err(|error| AuthError::Storage(error.to_string()))?)
        {
          return Err(AuthError::InvalidInput("Project managed admission changed".into()));
        }
        Ok(())
      }
      (
        StarterDocumentOrigin::TaskContainer(target),
        StarterDocumentAdmission::TaskContainer {
          target: expected,
          installation,
        },
      ) if target == expected => Self::context_target_fence(tx, receipt.workspace_id, target, installation).await,
      _ => Err(AuthError::InvalidInput("native document admission mismatch".into())),
    }
  }
}
