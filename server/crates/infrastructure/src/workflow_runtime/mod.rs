// SPDX-License-Identifier: AGPL-3.0-or-later
//! Glirulus advances accepted native actions. PostgreSQL/native receipts remain
//! authoritative for authorization, reserved identities and committed effects.
pub(crate) mod effects;
mod waits;
pub use effects::{acknowledge_runtime_effect, lock_runtime_effect};

use async_trait::async_trait;
use bytes::Bytes;
use glirulus_core::{
  TaskIndex,
  continuation_builder::FlowBuilder,
  snapshot::{SignalKind, SignalRequest},
  task::TaskMetadata,
};
use glirulus_persistence::{BackendError, SignalStore, SnapshotStore};
use glirulus_postgres::PostgresBackend;
use glirulus_runtime::{
  ExternalTaskExecutor, ExternalWorkflow, LiveWorkflowIndex, PooledWorker, WorkerHandle, serialization::JsonCodec,
};
use myoxus_application::workspace_automation::runtime::*;
use myoxus_domain::workspace_automation::{
  AutomationExecutionClaim, WorkspaceAutomationRun, WorkspaceAutomationRunStatus,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use std::{
  collections::HashMap,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
  time::Duration,
};
use tokio::sync::{Mutex, OnceCell};

type Backend = PostgresBackend<JsonCodec>;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeInput {
  format_version: u32,
  run_id: uuid::Uuid,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  context: Option<myoxus_domain::workspace_automation::ContextWorkflowEnvelope>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  setup: Option<myoxus_domain::workspace_automation::WorkspaceSetupWorkflowEnvelope>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  signal: Option<myoxus_domain::workspace_automation::WorkflowSignalEnvelope>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  routing_key: Option<String>,
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  routing_empty: bool,
}
impl RuntimeInput {
  fn for_signal(
    run: &AcceptedAutomationRun,
    mut signal: myoxus_domain::workspace_automation::WorkflowSignalEnvelope,
  ) -> RuntimeResult<Self> {
    if signal.format_version != 1 || signal.key.run_id != run.run_id {
      return Err(unavailable());
    }
    // JSONB and a reconstructed native receipt can order object keys differently.
    // Both deliveries must produce identical bytes for the same durable event.
    if let myoxus_domain::workspace_automation::WorkflowSignalOutcome::Accepted { result, .. } = &mut signal.outcome {
      result.sort_all_objects();
    }
    let mut input = Self::for_run(run);
    if let myoxus_domain::workspace_automation::WorkflowSignalOutcome::Accepted { outcome_key, .. } = &signal.outcome {
      input.routing_key = Some(outcome_key.clone());
    }
    input.signal = Some(signal);
    Ok(input)
  }
  fn for_run(run: &AcceptedAutomationRun) -> Self {
    Self {
      format_version: 1,
      run_id: run.run_id,
      signal: None,
      routing_key: None,
      routing_empty: false,
      setup: run.workspace_setup.as_ref().map(|origin| {
        myoxus_domain::workspace_automation::WorkspaceSetupWorkflowEnvelope {
          format_version: 1,
          request_id: origin.request_id,
          fingerprint: origin.fingerprint.clone(),
          results: Default::default(),
        }
      }),
      context: run.confirmed_request.as_ref().map(|origin| {
        myoxus_domain::workspace_automation::ContextWorkflowEnvelope {
          format_version: 1,
          request_id: origin.request_id,
          fingerprint: origin.fingerprint.clone(),
          target: origin.target.clone(),
          results: Default::default(),
        }
      }),
    }
  }
}

pub struct GlirulusWorkspaceAutomationRuntime {
  pool: PgPool,
  database_templates: Option<Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>>,
  executor: Arc<dyn WorkspaceAutomationNativeExecutor>,
  backend: OnceCell<Backend>,
  definitions: Mutex<HashMap<String, (AcceptedAutomationDefinition, glirulus_core::DefinitionHash)>>,
  index: LiveWorkflowIndex,
  worker_id: uuid::Uuid,
  worker: Mutex<Option<WorkerHandle<Backend>>>,
  supervisor: Mutex<Option<tokio::task::JoinHandle<()>>>,
  stopped: AtomicBool,
  recovery_cursor: Mutex<Option<uuid::Uuid>>,
  optional_automations_enabled: bool,
}

impl GlirulusWorkspaceAutomationRuntime {
  /// Construction is synchronous; CLI callers admit real work without starting
  /// another worker. The server explicitly calls readiness and start.
  pub fn new(pool: PgPool, executor: Arc<dyn WorkspaceAutomationNativeExecutor>) -> Self {
    Self {
      pool,
      database_templates: None,
      executor,
      backend: OnceCell::new(),
      definitions: Mutex::new(HashMap::new()),
      index: LiveWorkflowIndex::default(),
      worker_id: uuid::Uuid::new_v4(),
      worker: Mutex::new(None),
      supervisor: Mutex::new(None),
      stopped: AtomicBool::new(false),
      recovery_cursor: Mutex::new(None),
      optional_automations_enabled: true,
    }
  }
  /// Native recurrence remains available without admitting or waking optional
  /// Rule/assistant definitions. The two definition classes have disjoint hashes.
  pub fn with_optional_automations_enabled(mut self, enabled: bool) -> Self {
    self.optional_automations_enabled = enabled;
    self
  }

  pub(crate) async fn create_recurring_task_snapshot_in(
    &self,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run: &AcceptedAutomationRun,
  ) -> RuntimeResult<()> {
    myoxus_application::workspace_automation::recurring_task::validate(run)?;
    self.create_initial_snapshot_in(tx, run).await.map(|_| ())
  }

  async fn create_initial_snapshot_in(
    &self,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run: &AcceptedAutomationRun,
  ) -> RuntimeResult<glirulus_core::DefinitionHash> {
    let backend = self.backend.get().ok_or_else(unavailable)?;
    let (hash, _) = Self::compile(&run.definition)?;
    let input = Bytes::from(serde_json::to_vec(&RuntimeInput::for_run(run)).map_err(|_| unavailable())?);
    let mut snapshot =
      glirulus_core::snapshot::WorkflowSnapshot::with_initial_input(&run.run_id.to_string(), hash, input);
    Self::initialize_position(&mut snapshot, run)?;
    backend
      .create_snapshot_if_absent_in(&mut snapshot, tx)
      .await
      .map_err(|_| unavailable())?;
    Ok(hash)
  }

  /// Shared with scheduled Review admission; register/initialize the definition
  /// before opening the caller's transaction, never through another connection here.
  pub(crate) async fn accept_document_review_in(
    &self,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    proposed: &AcceptedAutomationRun,
  ) -> RuntimeResult<WorkspaceAutomationRun> {
    if !self.optional_automations_enabled || proposed.document_review.is_none() {
      return Err(unavailable());
    }
    let review = proposed.document_review.as_ref().ok_or_else(unavailable)?;
    let expected = myoxus_application::workspace_automation::review::compile_review_definition(
      &review.plan,
      proposed.definition.policy.clone(),
    )?;
    if expected.hash != proposed.definition.hash
      || myoxus_application::workspace_automation::review::review_wait(&proposed.definition)?.0 != review.wait_id
    {
      return Err(unavailable());
    }
    let run = crate::workspace_automation::PgWorkspaceAutomationRepository::accept_document_review_in(tx, proposed)
      .await
      .map_err(myoxus_application::workspace_automation::WorkspaceAutomationServiceError::from)?;
    if matches!(
      run.status,
      WorkspaceAutomationRunStatus::Queued | WorkspaceAutomationRunStatus::Running
    ) {
      let hash = self
        .create_initial_snapshot_in(tx, run.accepted.as_ref().ok_or_else(unavailable)?)
        .await?;
      let stored: Vec<u8> =
        sqlx::query_scalar("SELECT definition_hash FROM sayiir_workflow_snapshots WHERE instance_id=$1")
          .bind(run.id.to_string())
          .fetch_one(&mut **tx)
          .await
          .map_err(|_| unavailable())?;
      if stored.as_slice() != hash.as_bytes().as_slice() {
        return Err(unavailable());
      }
    }
    Ok(run)
  }
  /// Supply the validated node catalog before readiness/start initializes waits.
  pub fn with_database_templates(
    mut self,
    catalog: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    self.database_templates = Some(catalog);
    self
  }
  async fn backend(&self) -> RuntimeResult<&Backend> {
    self
      .backend
      .get_or_try_init(|| async {
        let backend = Backend::from_pool_without_migrations(self.pool.clone())
          .await
          .map_err(|_| unavailable())?;
        backend.set_eligible_definitions(vec![]);
        backend.set_wait_arbitrator(Arc::new(waits::NativeWaitArbitrator::new(
          self.database_templates.clone(),
        )));
        Ok(backend)
      })
      .await
  }
  pub async fn readiness(&self) -> RuntimeResult<()> {
    self.backend().await?;
    let marker: Option<String> =
      sqlx::query_scalar("SELECT obj_description('sayiir_workflow_snapshots'::regclass,'pg_class')")
        .fetch_one(&self.pool)
        .await
        .map_err(|_| unavailable())?;
    if marker.as_deref() != Some("myoxus-runtime-schema:1;sayiir:1.0.0") {
      return Err(unavailable());
    }
    sqlx::query("SELECT r.accepted_json,r.execution_generation,r.claim_owner,r.origin_kind,r.confirmed_actor_id,r.confirmed_request_id,r.review_wait_id,r.review_deadline_at,r.review_outcome_json,r.review_invalid_reason,r.review_expired_at,r.task_handover_state,r.task_correction_outcome_json,r.task_maintenance_invalid_reason,u.personal_config,u.execution_revision,p.automation_run_id,a.node_key,a.effect_key,a.input_fingerprint,a.reserved_id,a.expected_edit_revision,a.webhook_delivery_json,c.task_id,c.worker_id,c.expires_at,h.data,t.output,s.kind,e.signal_name,e.event_id,e.accepted_at,e.consumed_at,w.signal_name FROM workspace_automations u,workspace_automation_runs r,workspace_starter_applications p,workspace_automation_actions a,sayiir_workflow_claims c,sayiir_workflow_snapshot_history h,sayiir_workflow_tasks t,sayiir_workflow_signals s,sayiir_workflow_events e,sayiir_workflow_snapshots w LIMIT 0")
      .execute(&self.pool).await.map_err(|_| unavailable())?;
    let rows = sqlx::query("SELECT id,accepted_json FROM workspace_automation_runs WHERE accepted_json IS NOT NULL AND status IN ('queued','running') AND ($1 OR origin_kind='recurring_task') AND (origin_kind<>'workspace_setup' OR EXISTS(SELECT 1 FROM workspace_starter_applications root WHERE root.automation_run_id=workspace_automation_runs.id AND root.assistance_saved_at IS NOT NULL))")
      .bind(self.optional_automations_enabled)
      .fetch_all(&self.pool).await.map_err(|_| unavailable())?;
    for row in rows {
      let id = row.try_get("id").map_err(|_| unavailable())?;
      let value = row.try_get("accepted_json").map_err(|_| unavailable())?;
      match serde_json::from_value::<AcceptedAutomationRun>(value) {
        Ok(run) => {
          if self.register_definition(run.definition).await.is_err() {
            self.inputs_unavailable(id).await?;
          }
        }
        Err(_) => self.inputs_unavailable(id).await?,
      }
    }
    Ok(())
  }
  fn initialize_position(
    snapshot: &mut glirulus_core::snapshot::WorkflowSnapshot,
    run: &AcceptedAutomationRun,
  ) -> RuntimeResult<()> {
    if let Some(handover) = &run.task_handover {
      let workflow = run.definition.workflow.as_ref().ok_or_else(unavailable)?;
      let node = workflow.source.source.nodes.first().ok_or_else(unavailable)?;
      let count = handover.plan.prerequisites.len();
      let next = if count > 1 {
        format!("{}:signal:{}:1", run.definition.hash, node.id)
      } else {
        Self::task_name(&run.definition, 1)
      };
      let hint = glirulus_core::snapshot::TaskHint::new(&next, None, &[]);
      snapshot.set_task_hint(&hint);
      snapshot.update_position(glirulus_core::snapshot::ExecutionPosition::AtSignal {
        signal_id: glirulus_core::TaskId::from(format!("{}:signal:{}:0", run.definition.hash, node.id).as_str()),
        signal_name: myoxus_application::workspace_automation::handover::handover_wait_id(&run.definition, 0)?,
        wake_at: Some(handover.plan.deadline_at),
        next_task_id: Some(hint.id),
      });
    } else {
      let first = glirulus_core::snapshot::TaskHint::new(&Self::task_name(&run.definition, 0), None, &[]);
      snapshot.update_position(glirulus_core::snapshot::ExecutionPosition::AtTask { task_id: first.id });
      snapshot.set_task_hint(&first);
    }
    Ok(())
  }
  fn task_name(definition: &AcceptedAutomationDefinition, position: i32) -> String {
    format!("{}:action:{position}", definition.hash)
  }
  fn compile(
    definition: &AcceptedAutomationDefinition,
  ) -> RuntimeResult<(glirulus_core::DefinitionHash, ExternalWorkflow)> {
    if definition.format_version != 1
      || definition.runtime_schema_version != 1
      || definition.policy.max_retry_attempts == 0
      || definition.policy.webhook_timeout_seconds == 0
      || definition_hash(definition)? != definition.hash
    {
      return Err(unavailable());
    }
    let recurring = definition
      .capability_versions
      .contains_key(myoxus_application::workspace_automation::recurring_task::CAPABILITY);
    if recurring
      && (definition.workflow.is_some()
        || !definition.actions.is_empty()
        || definition.capability_versions.len() != 1
        || definition.capability_versions.values().next() != Some(&1))
    {
      return Err(unavailable());
    }
    if definition
      .workflow
      .as_ref()
      .is_some_and(|workflow| !workflow.components.is_empty())
      && !definition.capability_versions.contains_key("workspaceSetup")
    {
      return Self::compile_source_workflow(definition);
    }
    let count = if recurring {
      1
    } else if definition.capability_versions.contains_key("workspaceSetup") {
      myoxus_application::workspace_automation::setup::workspace_setup_stage_count(definition)?
    } else if definition.workflow.is_some() {
      myoxus_application::workspace_automation::workflows::context_stage_count(definition)?
    } else {
      if definition.actions.is_empty()
        || definition.actions.len() > definition.policy.max_actions_per_run as usize
        || definition.actions.iter().enumerate().any(|(position, action)| {
          action.position != position as i32
            || definition.capability_versions.get(action.config.action_type().as_str()) != Some(&1)
        })
        || definition.capability_versions.len()
          != definition
            .actions
            .iter()
            .map(|action| action.config.action_type().as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
      {
        return Err(unavailable());
      }
      definition.actions.len()
    };
    let mut builder = FlowBuilder::new();
    for position in 0..count {
      builder.add_sequential(
        Self::task_name(definition, position as i32),
        TaskMetadata {
          timeout: Some(Duration::from_secs(definition.policy.webhook_timeout_seconds.max(60))),
          retries: Some(glirulus_core::task::RetryPolicy {
            max_retries: definition.policy.max_retry_attempts - 1,
            initial_delay: Duration::from_secs(1),
            backoff_multiplier: 2.0,
            max_delay: Some(Duration::from_secs(60)),
          }),
          version: Some(definition.hash.clone()),
          ..Default::default()
        },
      );
    }
    let continuation = Arc::new(builder.build().map_err(|_| unavailable())?);
    let hash = continuation.to_serializable().compute_definition_hash();
    Ok((
      hash,
      ExternalWorkflow {
        task_index: Arc::new(TaskIndex::build(&continuation)),
        continuation,
        workflow_id: Arc::from("native-automation"),
        metadata_json: None,
      },
    ))
  }
  fn spawn_worker(&self, backend: Backend) -> WorkerHandle<Backend> {
    let pool = self.pool.clone();
    let owner = self.worker_id;
    let native = self.executor.clone();
    let engine = backend.clone();
    let executor: ExternalTaskExecutor = Arc::new(move |task, input| {
      let task = task.to_string();
      let pool = pool.clone();
      let native = native.clone();
      let engine = engine.clone();
      Box::pin(async move {
        let execute = async {
          let mut envelope: RuntimeInput = serde_json::from_slice(&input).map_err(|_| unavailable())?;
          if envelope.format_version != 1 {
            return Err(unavailable());
          }
          let row = sqlx::query(
            "SELECT accepted_json,execution_generation,claim_owner FROM workspace_automation_runs WHERE id=$1",
          )
          .bind(envelope.run_id)
          .fetch_one(&pool)
          .await
          .map_err(|_| unavailable())?;
          let run: AcceptedAutomationRun =
            serde_json::from_value(row.try_get("accepted_json").map_err(|_| unavailable())?)
              .map_err(|_| unavailable())?;
          let generation = row.try_get("execution_generation").map_err(|_| unavailable())?;
          if row
            .try_get::<Option<uuid::Uuid>, _>("claim_owner")
            .map_err(|_| unavailable())?
            != Some(owner)
          {
            return Err(unavailable());
          }
          let checkpoint = engine
            .load_snapshot(&run.run_id.to_string())
            .await
            .map_err(|_| unavailable())?;
          let attempts = checkpoint
            .get_retry_state(&glirulus_core::TaskId::from(task.as_str()))
            .map_or(1, |retry| retry.attempts.saturating_add(1));
          // Successful checkpoints clear retry state; retain the observed count
          // before invoking the native effect so later status reads cannot lose it.
          sqlx::query("UPDATE workspace_automation_runs SET attempt_count=GREATEST(attempt_count,$4) WHERE id=$1 AND claim_owner=$2 AND execution_generation=$3")
            .bind(run.run_id).bind(owner).bind(generation).bind(i32::try_from(attempts).unwrap_or(i32::MAX))
            .execute(&pool).await.map_err(|_| unavailable())?;
          if let Some(index) = task
            .strip_prefix("branch_")
            .and_then(|index| index.parse::<usize>().ok())
          {
            let workflow = run.definition.workflow.as_ref().ok_or_else(unavailable)?;
            let branches =
              myoxus_application::workspace_automation::workflows::native_workflow_nodes(&workflow.source.source)
                .into_iter()
                .filter_map(|node| match &node.action {
                  myoxus_domain::assistant_package::AssistantWorkflowAction::Branch { cases, .. } => Some(cases),
                  _ => None,
                })
                .collect::<Vec<_>>();
            let cases = branches.get(index).ok_or_else(unavailable)?;
            let signal = envelope.signal.as_ref().ok_or_else(unavailable)?;
            let myoxus_domain::workspace_automation::WorkflowSignalOutcome::Accepted { outcome_key, .. } =
              &signal.outcome
            else {
              return Err(unavailable());
            };
            if signal.key.run_id != run.run_id
              || envelope.routing_key.as_deref() != Some(outcome_key.as_str())
              || !cases.contains_key(outcome_key)
            {
              return Err(unavailable());
            }
            envelope.routing_empty = cases.get(outcome_key).is_some_and(Vec::is_empty);
            return Ok(Bytes::from(serde_json::to_vec(&envelope).map_err(|_| unavailable())?));
          }
          let node = task
            .strip_prefix(&format!("{}:", run.definition.hash))
            .ok_or_else(unavailable)?
            .to_string();
          let result = native
            .execute(AutomationEffectInvocation {
              run_id: run.run_id,
              input_fingerprint: effect_input_fingerprint(&run, &node, "apply")?,
              node_key: node.clone(),
              effect_key: "apply".into(),
              claim: AutomationExecutionClaim { owner, generation },
              setup: envelope.setup.clone(),
              context: envelope.context.clone(),
              signal: envelope.signal.clone(),
            })
            .await?;
          if let Some(context) = envelope.context.as_mut() {
            let result: myoxus_domain::workspace_automation::ContextWorkflowResult =
              serde_json::from_value(result.result).map_err(|_| unavailable())?;
            context.results.insert(node, result);
            return Ok(Bytes::from(serde_json::to_vec(&envelope).map_err(|_| unavailable())?));
          }
          if let Some(setup) = envelope.setup.as_mut() {
            let result: myoxus_domain::workspace_automation::WorkspaceSetupStageResult =
              serde_json::from_value(result.result).map_err(|_| unavailable())?;
            setup.results.insert(node, result);
            return Ok(Bytes::from(serde_json::to_vec(&envelope).map_err(|_| unavailable())?));
          }
          Ok::<_, myoxus_application::workspace_automation::WorkspaceAutomationServiceError>(input)
        };
        execute.await.map_err(|error| -> glirulus_core::error::BoxError {
          tracing::warn!(code = error.code, "native automation action rejected");
          Box::new(std::io::Error::other("native automation action unavailable"))
        })
      })
    });
    PooledWorker::new(owner.to_string(), backend, glirulus_core::registry::TaskRegistry::new())
      .with_claim_ttl(Some(Duration::from_secs(60)))
      .spawn_with_live_executor(Duration::from_secs(1), self.index.clone(), executor)
  }
  fn compile_source_workflow(
    definition: &AcceptedAutomationDefinition,
  ) -> RuntimeResult<(glirulus_core::DefinitionHash, ExternalWorkflow)> {
    use myoxus_domain::assistant_package::AssistantWorkflowAction as Action;
    let workflow = definition.workflow.as_ref().ok_or_else(unavailable)?;
    if !workflow.stages.is_empty()
      || myoxus_application::workspace_automation::workflows::maximum_workflow_effects(&workflow.source.source.nodes)
        > definition.policy.max_actions_per_run as usize
    {
      return Err(unavailable());
    }
    let nodes = myoxus_application::workspace_automation::workflows::native_workflow_nodes(&workflow.source.source);
    let expanded_count = nodes.len()
      + workflow
        .wait_counts
        .values()
        .map(|count| count.saturating_sub(1) as usize)
        .sum::<usize>();
    if nodes.is_empty() || expanded_count > 64 {
      return Err(unavailable());
    }
    let metadata = || TaskMetadata {
      timeout: Some(Duration::from_secs(definition.policy.webhook_timeout_seconds.max(60))),
      retries: Some(glirulus_core::task::RetryPolicy {
        max_retries: definition.policy.max_retry_attempts - 1,
        initial_delay: Duration::from_secs(1),
        backoff_multiplier: 2.0,
        max_delay: Some(Duration::from_secs(60)),
      }),
      version: Some(definition.hash.clone()),
      ..Default::default()
    };
    let task =
      |node: &myoxus_domain::assistant_package::AssistantWorkflowNode| -> RuntimeResult<(String, TaskMetadata)> {
        if !matches!(
          &node.action,
          Action::CreateTaskFromDocument { .. }
            | Action::InspectTaskContent { .. }
            | Action::ApplyTaskCorrections { .. }
            | Action::CreateLinkedDocument { .. }
        ) {
          return Err(unavailable());
        }
        let position = nodes
          .iter()
          .position(|candidate| candidate.id == node.id)
          .ok_or_else(unavailable)?;
        Ok((Self::task_name(definition, position as i32), metadata()))
      };
    let mut builder = FlowBuilder::new();
    for node in &workflow.source.source.nodes {
      match &node.action {
        Action::CreateDatabaseFromDefinition { .. }
        | Action::CreateWorkingDocument { .. }
        | Action::PlaceNativeLink { .. } => return Err(unavailable()),
        Action::CreateTaskFromDocument { .. }
        | Action::InspectTaskContent { .. }
        | Action::ApplyTaskCorrections { .. }
        | Action::CreateLinkedDocument { .. } => {
          let (name, metadata) = task(node)?;
          builder.add_sequential(name, metadata);
        }
        Action::AwaitTaskSet { wait_id, .. } => {
          let count = *workflow.wait_counts.get(wait_id).ok_or_else(unavailable)?;
          if count == 0 || count > 64 {
            return Err(unavailable());
          }
          for index in 0..count {
            builder
              .add_signal(
                format!("{}:signal:{}:{index}", definition.hash, node.id),
                format!("{wait_id}:{index}"),
                None,
              )
              .map_err(|_| unavailable())?;
          }
        }
        Action::AwaitSignal { wait_id, .. } | Action::AwaitCorrectionConfirmation { wait_id } => builder
          .add_signal(format!("{}:signal:{}", definition.hash, node.id), wait_id.clone(), None)
          .map_err(|_| unavailable())?,
        Action::Branch { cases, .. } => {
          let branches = cases
            .iter()
            .filter(|(_, nodes)| !nodes.is_empty())
            .map(|(key, nodes)| Ok((key.clone(), nodes.iter().map(&task).collect::<RuntimeResult<Vec<_>>>()?)))
            .collect::<RuntimeResult<Vec<_>>>()?;
          builder.add_branch(branches, None).map_err(|_| unavailable())?;
        }
        _ => return Err(unavailable()),
      }
    }
    let continuation = Arc::new(builder.build().map_err(|_| unavailable())?);
    let hash = continuation.to_serializable().compute_definition_hash();
    Ok((
      hash,
      ExternalWorkflow {
        task_index: Arc::new(TaskIndex::build(&continuation)),
        continuation,
        workflow_id: Arc::from("native-automation"),
        metadata_json: None,
      },
    ))
  }
  pub async fn start(self: &Arc<Self>) -> RuntimeResult<()> {
    self.readiness().await?;
    let mut supervisor = self.supervisor.lock().await;
    if supervisor.is_some() {
      return Ok(());
    }
    *self.worker.lock().await = Some(self.spawn_worker(self.backend().await?.clone()));
    let weak = Arc::downgrade(self);
    *supervisor = Some(tokio::spawn(async move {
      loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(runtime) = weak.upgrade() else { break };
        if runtime.stopped.load(Ordering::Acquire) {
          break;
        }
        if runtime.recover().await.is_err() {
          tracing::warn!("automation runtime recovery unavailable");
        }
        let mut worker = runtime.worker.lock().await;
        if worker.as_ref().is_some_and(WorkerHandle::is_finished) {
          if let Some(previous) = worker.take() {
            let _ = previous.join().await;
          }
          tracing::warn!("automation pooled worker restarted after termination");
          if let Ok(backend) = runtime.backend().await {
            *worker = Some(runtime.spawn_worker(backend.clone()));
          }
        }
      }
    }));
    Ok(())
  }
  async fn recover(&self) -> RuntimeResult<()> {
    let mut cursor = self.recovery_cursor.lock().await;
    let rows = sqlx::query("SELECT id,accepted_json FROM workspace_automation_runs WHERE status IN ('queued','running') AND ($2 OR origin_kind='recurring_task') AND (origin_kind<>'workspace_setup' OR EXISTS(SELECT 1 FROM workspace_starter_applications root WHERE root.automation_run_id=workspace_automation_runs.id AND root.assistance_saved_at IS NOT NULL)) AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 100")
      .bind(*cursor).bind(self.optional_automations_enabled).fetch_all(&self.pool).await.map_err(|_| unavailable())?;
    if rows.is_empty() {
      *cursor = None;
    }
    for row in rows {
      let id: uuid::Uuid = row.try_get("id").map_err(|_| unavailable())?;
      *cursor = Some(id);
      let accepted: Option<serde_json::Value> = row.try_get("accepted_json").map_err(|_| unavailable())?;
      let Some(value) = accepted else {
        self.inputs_unavailable(id).await?;
        continue;
      };
      let Ok(run) = serde_json::from_value::<AcceptedAutomationRun>(value) else {
        self.inputs_unavailable(id).await?;
        continue;
      };
      if Self::compile(&run.definition).is_err() {
        self.inputs_unavailable(id).await?;
        continue;
      }
      if self
        .backend()
        .await?
        .check_and_cancel(&run.run_id.to_string(), None)
        .await
        .map_err(|_| unavailable())?
      {
        self.status(run.run_id).await?;
        continue;
      }
      if self.ensure_started(run.clone()).await.is_err() {
        tracing::warn!(run_id=%run.run_id,"accepted automation recovery unavailable");
        continue;
      }
      if self.status(run.run_id).await.is_err() {
        tracing::warn!(run_id=%run.run_id,"automation status unavailable");
      }
    }
    Ok(())
  }
  async fn inputs_unavailable(&self, run_id: uuid::Uuid) -> RuntimeResult<()> {
    self
      .executor
      .synchronize_status(AutomationRuntimeStatus {
        run_id,
        status: WorkspaceAutomationRunStatus::Failed,
        reason_code: Some("MIX_AUTOMATION_INPUTS_UNAVAILABLE".into()),
      })
      .await
  }
  pub async fn shutdown(&self, deadline: Duration) -> RuntimeResult<()> {
    self.stopped.store(true, Ordering::Release);
    if let Some(task) = self.supervisor.lock().await.take() {
      task.abort();
      let _ = task.await;
    }
    if let Some(worker) = self.worker.lock().await.take() {
      worker
        .shutdown_with_timeout(deadline)
        .await
        .map_err(|_| unavailable())?;
    }
    Ok(())
  }
}

#[async_trait]
impl WorkspaceAutomationRuntime for GlirulusWorkspaceAutomationRuntime {
  #[tracing::instrument(skip_all, fields(run_id=%accepted.run_id,workspace_id=%accepted.workspace_id))]
  async fn accept_document_review(&self, accepted: AcceptedAutomationRun) -> RuntimeResult<WorkspaceAutomationRun> {
    self.register_definition(accepted.definition.clone()).await?;
    let mut tx = self.pool.begin().await.map_err(|_| unavailable())?;
    let run = self.accept_document_review_in(&mut tx, &accepted).await?;
    tx.commit().await.map_err(|_| unavailable())?;
    Ok(run)
  }
  async fn signal(
    &self,
    signal: myoxus_domain::workspace_automation::WorkflowSignalEnvelope,
  ) -> RuntimeResult<myoxus_domain::workspace_automation::WorkflowSignalDelivery> {
    use myoxus_domain::workspace_automation::WorkflowSignalDelivery;
    let backend = self.backend().await?;
    let mut tx = self.pool.begin().await.map_err(|_| unavailable())?;
    let original: Option<serde_json::Value> =
      sqlx::query_scalar("SELECT payload FROM outbox_events WHERE id=$1 AND event_type='workspace_automation_signal'")
        .bind(signal.event_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| unavailable())?;
    if original != Some(serde_json::to_value(&signal).map_err(|_| unavailable())?) {
      return Err(unavailable());
    }
    let value: serde_json::Value =
      sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
        .bind(signal.key.run_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| unavailable())?;
    let run: AcceptedAutomationRun = serde_json::from_value(value).map_err(|_| unavailable())?;
    let input = RuntimeInput::for_signal(&run, signal.clone())?;
    let created = backend
      .send_correlated_event_in(
        &mut tx,
        &signal.key.run_id.to_string(),
        &signal.key.wait_id,
        &signal.event_id.to_string(),
        signal.accepted_at,
        Bytes::from(serde_json::to_vec(&input).map_err(|_| unavailable())?),
      )
      .await
      .map_err(|_| unavailable())?;
    tx.commit().await.map_err(|_| unavailable())?;
    Ok(if created {
      WorkflowSignalDelivery::Accepted
    } else {
      WorkflowSignalDelivery::AlreadyAccepted
    })
  }
  async fn wait_status(
    &self,
    key: myoxus_domain::workspace_automation::WorkflowWaitKey,
  ) -> RuntimeResult<myoxus_domain::workspace_automation::WorkflowWaitStatus> {
    let row=sqlx::query("SELECT review_wait_id,review_deadline_at,review_outcome_json,review_expired_at FROM workspace_automation_runs WHERE id=$1").bind(key.run_id).fetch_one(&self.pool).await.map_err(|_|unavailable())?;
    if row.try_get::<String, _>("review_wait_id").map_err(|_| unavailable())? != key.wait_id {
      return Err(unavailable());
    }
    let decision = row
      .try_get::<Option<serde_json::Value>, _>("review_outcome_json")
      .map_err(|_| unavailable())?
      .map(serde_json::from_value::<myoxus_domain::workspace_automation::DocumentReviewDecisionReceipt>)
      .transpose()
      .map_err(|_| unavailable())?;
    Ok(myoxus_domain::workspace_automation::WorkflowWaitStatus {
      key,
      deadline_at: row.try_get("review_deadline_at").map_err(|_| unavailable())?,
      accepted_event_id: decision.map(|receipt| receipt.event_id),
      expired: row
        .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("review_expired_at")
        .map_err(|_| unavailable())?
        .is_some(),
    })
  }

  async fn register_definition(&self, definition: AcceptedAutomationDefinition) -> RuntimeResult<()> {
    if !self.optional_automations_enabled
      && !definition
        .capability_versions
        .contains_key(myoxus_application::workspace_automation::recurring_task::CAPABILITY)
    {
      return Err(unavailable());
    }
    let (hash, workflow) = Self::compile(&definition)?;
    // Initialize the fallible backend before publishing a cached registration:
    // a failed first admission must not leave a definition permanently ineligible.
    let backend = self.backend().await?;
    let mut definitions = self.definitions.lock().await;
    if let Some((existing, _)) = definitions.get(&definition.hash) {
      if serde_json::to_value(existing).map_err(|_| unavailable())?
        != serde_json::to_value(&definition).map_err(|_| unavailable())?
      {
        return Err(unavailable());
      }
      return Ok(());
    }
    self.index.insert(hash, workflow);
    definitions.insert(definition.hash.clone(), (definition, hash));
    backend.set_eligible_definitions(definitions.values().map(|(_, hash)| *hash).collect());
    Ok(())
  }
  async fn ensure_started(&self, run: AcceptedAutomationRun) -> RuntimeResult<()> {
    self.register_definition(run.definition.clone()).await?;
    let backend = self.backend().await?;
    let stored: Option<serde_json::Value> = sqlx::query_scalar(
      "SELECT accepted_json FROM workspace_automation_runs WHERE id=$1 AND status IN ('queued','running') AND (origin_kind<>'workspace_setup' OR EXISTS(SELECT 1 FROM workspace_starter_applications root WHERE root.automation_run_id=workspace_automation_runs.id AND root.assistance_saved_at IS NOT NULL))",
    )
    .bind(run.run_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(|_| unavailable())?
    .flatten();
    if stored != Some(serde_json::to_value(&run).map_err(|_| unavailable())?) {
      return Err(unavailable());
    }
    match backend.load_snapshot(&run.run_id.to_string()).await {
      Ok(snapshot) => {
        let definitions = self.definitions.lock().await;
        if definitions.get(&run.definition.hash).map(|(_, hash)| *hash) != Some(snapshot.definition_hash) {
          return Err(unavailable());
        }
      }
      Err(BackendError::NotFound(_)) => {
        let definitions = self.definitions.lock().await;
        let hash = definitions.get(&run.definition.hash).ok_or_else(unavailable)?.1;
        let input = Bytes::from(serde_json::to_vec(&RuntimeInput::for_run(&run)).map_err(|_| unavailable())?);
        let mut snapshot =
          glirulus_core::snapshot::WorkflowSnapshot::with_initial_input(&run.run_id.to_string(), hash, input);
        Self::initialize_position(&mut snapshot, &run)?;
        backend
          .create_snapshot_if_absent(&mut snapshot)
          .await
          .map_err(|_| unavailable())?;
        if backend
          .load_snapshot(&run.run_id.to_string())
          .await
          .map_err(|_| unavailable())?
          .definition_hash
          != hash
        {
          return Err(unavailable());
        }
      }
      Err(_) => return Err(unavailable()),
    }
    if run.task_handover.is_some() {
      backend
        .consume_event(
          &run.run_id.to_string(),
          &myoxus_application::workspace_automation::handover::handover_wait_id(&run.definition, 0)?,
        )
        .await
        .map_err(|_| unavailable())?;
    }
    Ok(())
  }
  async fn status(&self, run_id: uuid::Uuid) -> RuntimeResult<AutomationRuntimeStatus> {
    let snapshot = self
      .backend()
      .await?
      .load_snapshot(&run_id.to_string())
      .await
      .map_err(|_| unavailable())?;
    let observed = snapshot
      .task_retries
      .values()
      .map(|retry| retry.attempts.saturating_add(1))
      .max()
      .unwrap_or(1);
    let row = sqlx::query("UPDATE workspace_automation_runs SET attempt_count=GREATEST(attempt_count,CASE WHEN execution_generation>0 THEN $2 ELSE 0 END) WHERE id=$1 RETURNING accepted_json,attempt_count")
      .bind(run_id).bind(i32::try_from(observed).unwrap_or(i32::MAX)).fetch_one(&self.pool).await.map_err(|_| unavailable())?;
    let run: AcceptedAutomationRun =
      serde_json::from_value(row.try_get("accepted_json").map_err(|_| unavailable())?).map_err(|_| unavailable())?;
    let exhausted = row.try_get::<i32, _>("attempt_count").map_err(|_| unavailable())? as u32
      >= run.definition.policy.max_retry_attempts;
    let (status, reason) = if snapshot.state.is_completed() {
      (WorkspaceAutomationRunStatus::Succeeded, None)
    } else if snapshot.state.is_failed() {
      (
        if exhausted {
          WorkspaceAutomationRunStatus::DeadLetter
        } else {
          WorkspaceAutomationRunStatus::Failed
        },
        Some("AUTOMATION_RUNTIME_FAILED".to_string()),
      )
    } else if snapshot.state.is_terminal() {
      (
        WorkspaceAutomationRunStatus::Skipped,
        Some("AUTOMATION_RUNTIME_STOPPED".to_string()),
      )
    } else {
      (WorkspaceAutomationRunStatus::Running, None)
    };
    let status = AutomationRuntimeStatus {
      run_id,
      status,
      reason_code: reason,
    };
    self.executor.synchronize_status(status.clone()).await?;
    Ok(status)
  }
  async fn retry(&self, run_id: uuid::Uuid) -> RuntimeResult<()> {
    let backend = self.backend().await?;
    let mut tx = self.pool.begin().await.map_err(|_| unavailable())?;
    let live: Option<bool> = sqlx::query_scalar(
      "SELECT expires_at IS NULL OR expires_at>now() FROM sayiir_workflow_claims WHERE instance_id=$1 FOR UPDATE",
    )
    .bind(run_id.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| unavailable())?;
    if live == Some(true) {
      return Err(unavailable());
    }
    let row = sqlx::query("SELECT accepted_json,status,review_invalid_reason,review_expired_at,review_deadline_at,review_outcome_json,task_handover_state,task_maintenance_invalid_reason FROM workspace_automation_runs WHERE id=$1 FOR UPDATE")
      .bind(run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(|_| unavailable())?;
    let state: String = row.try_get("status").map_err(|_| unavailable())?;
    // Replaying an acknowledged retry does not restart its already queued work.
    if matches!(state.as_str(), "queued" | "running") {
      return Ok(());
    }
    if !matches!(state.as_str(), "failed" | "dead_letter") {
      return Err(unavailable());
    }
    let run: AcceptedAutomationRun =
      serde_json::from_value(row.try_get("accepted_json").map_err(|_| unavailable())?).map_err(|_| unavailable())?;
    if run.task_maintenance.is_some()
      && row
        .try_get::<Option<String>, _>("task_maintenance_invalid_reason")
        .map_err(|_| unavailable())?
        .is_some()
    {
      return Err(unavailable());
    }
    if run.document_review.is_some()
      && (row
        .try_get::<Option<String>, _>("review_invalid_reason")
        .map_err(|_| unavailable())?
        .is_some()
        || row
          .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("review_expired_at")
          .map_err(|_| unavailable())?
          .is_some()
        || (row
          .try_get::<Option<serde_json::Value>, _>("review_outcome_json")
          .map_err(|_| unavailable())?
          .is_none()
          && row
            .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("review_deadline_at")
            .map_err(|_| unavailable())?
            .is_none_or(|deadline| deadline <= chrono::Utc::now())))
    {
      return Err(unavailable());
    }
    if let Some(handover) = &run.task_handover {
      let state: myoxus_domain::workspace_automation::TaskHandoverState =
        serde_json::from_value(row.try_get("task_handover_state").map_err(|_| unavailable())?)
          .map_err(|_| unavailable())?;
      if state.invalid_reason.is_some()
        || state.expired_at.is_some()
        || (state.completions.len() != handover.plan.prerequisites.len()
          && handover.plan.deadline_at <= chrono::Utc::now())
      {
        return Err(unavailable());
      }
    }
    self.register_definition(run.definition.clone()).await?;
    let (hash, _) = Self::compile(&run.definition)?;
    let input = Bytes::from(serde_json::to_vec(&RuntimeInput::for_run(&run)).map_err(|_| unavailable())?);
    let mut snapshot = glirulus_core::snapshot::WorkflowSnapshot::with_initial_input(&run_id.to_string(), hash, input);
    Self::initialize_position(&mut snapshot, &run)?;
    let existing =
      sqlx::query("SELECT status,definition_hash FROM sayiir_workflow_snapshots WHERE instance_id=$1 FOR UPDATE")
        .bind(run_id.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| unavailable())?;
    if let Some(existing) = existing {
      if existing
        .try_get::<Vec<u8>, _>("definition_hash")
        .map_err(|_| unavailable())?
        .as_slice()
        != hash.as_bytes().as_slice()
      {
        return Err(unavailable());
      }
      match existing
        .try_get::<String, _>("status")
        .map_err(|_| unavailable())?
        .as_str()
      {
        "Failed" => backend
          .restart_failed_snapshot_in(&mut snapshot, &mut tx)
          .await
          .map_err(|_| unavailable())?,
        "InProgress" => {} // Previously unavailable implementation; resume its unchanged checkpoint.
        _ => return Err(unavailable()),
      }
    } else {
      // Native admission may have committed just before a crash, without an
      // engine snapshot. Retry admits that same frozen identity in this Tx.
      backend
        .create_snapshot_if_absent_in(&mut snapshot, &mut tx)
        .await
        .map_err(|_| unavailable())?;
    }
    sqlx::query("UPDATE workspace_automation_runs SET status='queued',execution_generation=execution_generation+1,claim_owner=NULL,error_code=NULL,error_message=NULL,dead_letter=false,queued_at=now(),started_at=NULL,finished_at=NULL WHERE id=$1")
      .bind(run_id).execute(&mut *tx).await.map_err(|_| unavailable())?;
    tx.commit().await.map_err(|_| unavailable())?;
    if run.task_handover.is_some() {
      backend
        .consume_event(
          &run_id.to_string(),
          &myoxus_application::workspace_automation::handover::handover_wait_id(&run.definition, 0)?,
        )
        .await
        .map_err(|_| unavailable())?;
    }
    Ok(())
  }
  async fn cancel(&self, run_id: uuid::Uuid) -> RuntimeResult<()> {
    let backend = self.backend().await?;
    let mut tx = self.pool.begin().await.map_err(|_| unavailable())?;
    sqlx::query("SELECT instance_id FROM sayiir_workflow_claims WHERE instance_id=$1 FOR UPDATE")
      .bind(run_id.to_string())
      .fetch_optional(&mut *tx)
      .await
      .map_err(|_| unavailable())?;
    let row = sqlx::query("SELECT status,accepted_json FROM workspace_automation_runs WHERE id=$1 FOR UPDATE")
      .bind(run_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(|_| unavailable())?;
    let state: String = row.try_get("status").map_err(|_| unavailable())?;
    if !matches!(state.as_str(), "queued" | "running" | "skipped") {
      return Ok(());
    }
    let exists: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sayiir_workflow_snapshots WHERE instance_id=$1)")
        .bind(run_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| unavailable())?;
    if !exists {
      let run: AcceptedAutomationRun =
        serde_json::from_value(row.try_get("accepted_json").map_err(|_| unavailable())?).map_err(|_| unavailable())?;
      let (hash, _) = Self::compile(&run.definition)?;
      let input = Bytes::from(serde_json::to_vec(&RuntimeInput::for_run(&run)).map_err(|_| unavailable())?);
      let mut snapshot =
        glirulus_core::snapshot::WorkflowSnapshot::with_initial_input(&run_id.to_string(), hash, input);
      Self::initialize_position(&mut snapshot, &run)?;
      backend
        .create_snapshot_if_absent_in(&mut snapshot, &mut tx)
        .await
        .map_err(|_| unavailable())?;
    }
    // Generation invalidation and the engine signal commit together. The
    // native terminal transition/audit follows the engine's actual outcome.
    backend
      .store_signal_in(
        &run_id.to_string(),
        SignalKind::Cancel,
        SignalRequest::new(None, None),
        &mut tx,
      )
      .await
      .map_err(|_| unavailable())?;
    sqlx::query(
      "UPDATE workspace_automation_runs SET execution_generation=execution_generation+1,claim_owner=NULL WHERE id=$1",
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| unavailable())?;
    tx.commit().await.map_err(|_| unavailable())?;
    backend
      .check_and_cancel(&run_id.to_string(), None)
      .await
      .map_err(|_| unavailable())?;
    self.status(run_id).await?;
    Ok(())
  }
}
