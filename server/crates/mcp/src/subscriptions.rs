// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared current-state comparison for SDK resource subscriptions.
//!
//! Wakeups carry no content or authority. SDK contexts/sinks own wire lifecycle;
//! retained bindings contain personal-key IDs and resource identities, not tokens.

use crate::{auth::McpAuthContext, tools::McpToolState};
use myoxus_application::api_key::ApiKeyService;
use rmcp::{
  ErrorData,
  model::{ResourceUpdatedNotification, ResourceUpdatedNotificationParam, ServerNotification, SubscriptionFilter},
  service::SubscriptionContext,
};
use std::sync::Arc;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Shared subscription fanout state (held in `Arc` in MCP router state).
#[derive(Debug, Clone, Default)]
pub struct SubscriptionHub {
  observer: ResourceObserver,
}

impl SubscriptionHub {
  pub fn new() -> Self {
    Self::with_updates(myoxus_application::events::WorkspaceResourceUpdates::default())
  }

  pub fn with_updates(updates: myoxus_application::events::WorkspaceResourceUpdates) -> Self {
    Self {
      observer: ResourceObserver::new(updates),
    }
  }

  /// In-process lifecycle diagnostic; no credentials or resource identifiers.
  pub fn active_observation_groups(&self) -> usize {
    self
      .observer
      .inner
      .state
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .groups
      .len()
  }

  /// Syntactic support only. The SDK acknowledges this subset before listen;
  /// it is deliberately not an authorization or resource-existence assertion.
  pub(crate) fn accepted_filter(requested: &SubscriptionFilter) -> SubscriptionFilter {
    let mut accepted = SubscriptionFilter::new();
    accepted.resource_subscriptions = requested
      .resource_subscriptions
      .as_ref()
      .map(|uris| uris.iter().filter(|uri| target(uri).is_some()).cloned().collect());
    accepted
  }

  #[tracing::instrument(skip_all)]
  pub(crate) async fn listen(
    &self,
    context: &SubscriptionContext,
    keys: &ApiKeyService,
    state: &McpToolState,
  ) -> Result<(), ErrorData> {
    let auth = crate::router::request_auth(context.request_context())?.clone();
    current_authority(keys, auth.key_id, auth.user_id).await?;
    let mut leases = HashMap::<Uuid, ObservationLease>::new();
    let mut bindings = Vec::new();
    for uri in context.accepted().resource_subscriptions.as_deref().unwrap_or_default() {
      let target = target(uri).ok_or_else(denied)?;
      let workspace = target.workspace();
      if let std::collections::hash_map::Entry::Vacant(entry) = leases.entry(workspace) {
        let lease = self.observer.observe(
          auth.key_id,
          auth.user_id,
          workspace,
          keys.clone(),
          crate::resources::resource_inventory(state),
          state.document_export_max_bytes,
        );
        tokio::select! {
          _ = context.cancelled() => return Ok(()),
          result = lease.refresh() => { result.map_err(|_| denied())?; }
        }
        entry.insert(lease);
      }
      let identity = authorize_target(&target, &auth, state).await?;
      bindings.push(Binding {
        uri: uri.clone(),
        target,
        identity,
        previous: None,
      });
    }
    while !bindings.is_empty() {
      let views = leases
        .iter_mut()
        .map(|(workspace, lease)| (*workspace, lease.values.borrow_and_update().clone()))
        .collect::<HashMap<_, _>>();
      let mut retained = Vec::new();
      for mut binding in bindings {
        let Some(value) = views.get(&binding.target.workspace()).cloned().flatten() else {
          retained.push(binding);
          continue;
        };
        let view = match value {
          Ok(view) => view,
          Err(()) => {
            // Key/account loss ends the stream; workspace/storage failure
            // retires only that group's bindings, never its last private state.
            current_authority(keys, auth.key_id, auth.user_id).await?;
            continue;
          }
        };
        if let Target::Document(_, ref key) = binding.target
          && !view.documents.contains_key(key)
        {
          continue;
        }
        let observed = match &binding.target {
          Target::Inventory(_) => ObservedTarget::Inventory(view.clone()),
          Target::Document(_, key) => ObservedTarget::Document(view.documents[key].clone()),
        };
        let changed = binding.previous.as_ref() != Some(&observed);
        if changed {
          // A queued comparison is not durable authority. Recheck credentials
          // and the exact target immediately before releasing even a URI hint.
          let fresh = current_authority(keys, auth.key_id, auth.user_id).await?;
          let identity = match authorize_target(&binding.target, &fresh, state).await {
            Ok(identity) => identity,
            Err(_) if matches!(binding.target, Target::Document(..)) => continue,
            Err(error) => return Err(error),
          };
          if identity != binding.identity {
            continue;
          }
          let notification = ServerNotification::ResourceUpdatedNotification(ResourceUpdatedNotification::new(
            ResourceUpdatedNotificationParam::new(binding.uri.clone()),
          ));
          tokio::select! {
            _ = context.cancelled() => return Ok(()),
            result = context.sink().send(notification) => { if result.is_err() { return Ok(()); } }
          }
          binding.previous = Some(observed);
        }
        retained.push(binding);
      }
      bindings = retained;
      leases.retain(|workspace, _| bindings.iter().any(|binding| binding.target.workspace() == *workspace));
      if leases.is_empty() {
        break;
      }
      {
        let changed =
          futures_util::future::select_all(leases.values_mut().map(|lease| Box::pin(lease.values.changed())));
        tokio::select! {
          _ = context.cancelled() => return Ok(()),
          _ = changed => {},
        }
      }
    }
    Ok(())
  }
}

fn denied() -> ErrorData {
  ErrorData::new(
    rmcp::model::ErrorCode(-32003),
    "Resource subscription is no longer authorized or available",
    None,
  )
}

async fn current_authority(keys: &ApiKeyService, key: Uuid, owner: Uuid) -> Result<McpAuthContext, ErrorData> {
  let key = keys.revalidate(key, owner).await.map_err(|_| denied())?;
  let auth = McpAuthContext {
    user_id: key.user_id,
    key_id: key.id,
    scopes: key.scopes,
  };
  if !auth.has_scope("read:workspaces") || !auth.has_scope("read:docs") {
    return Err(denied());
  }
  Ok(auth)
}

enum Target {
  Inventory(Uuid),
  Document(Uuid, String),
}
impl Target {
  fn workspace(&self) -> Uuid {
    match self {
      Self::Inventory(workspace) | Self::Document(workspace, _) => *workspace,
    }
  }
}
struct Binding {
  uri: String,
  target: Target,
  identity: Option<Uuid>,
  previous: Option<ObservedTarget>,
}

// A document binding retains only its own signature, not an old complete
// workspace view for every selected document.
#[derive(PartialEq, Eq)]
enum ObservedTarget {
  Inventory(Arc<WorkspaceObservation>),
  Document(myoxus_application::workspace::resource_inventory::InventoryDocument),
}

fn target(uri: &str) -> Option<Target> {
  if uri.starts_with("myoxus-workspace://") {
    if uri.contains('?') {
      return None;
    }
    return crate::resources::inventory_target(uri)
      .ok()
      .map(|(workspace, _)| Target::Inventory(workspace));
  }
  let (workspace, key) = crate::resources::resource_target(uri).ok()?;
  key.map(|key| Target::Document(workspace, key.into_string()))
}

async fn authorize_target(
  target: &Target,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Option<Uuid>, ErrorData> {
  use myoxus_domain::permission::{DocAction, WorkspaceAction};
  let workspace = target.workspace();
  let memberships = state
    .workspace_service
    .list_workspaces(auth.user_id)
    .await
    .map_err(|_| denied())?;
  if !memberships
    .iter()
    .any(|row| row.id == workspace && row.deleted_at.is_none())
    || !state
      .permission_service
      .get_effective_workspace_role(auth.user_id, workspace)
      .await
      .map_err(|_| denied())?
      .is_some_and(|role| role.can(WorkspaceAction::Read))
  {
    return Err(denied());
  }
  if let Target::Document(_, key) = target {
    let key = myoxus_domain::document_key::DocumentKey::parse(key.clone()).map_err(|_| denied())?;
    let id = state
      .doc_service
      .resolve_document_key(workspace, myoxus_application::doc::DocSpaceKind::Workspace, &key)
      .await
      .map_err(|_| denied())?
      .ok_or_else(denied)?;
    let metadata = state
      .doc_service
      .get_doc_metadata(id)
      .await
      .map_err(|_| denied())?
      .ok_or_else(denied)?;
    if metadata.workspace_id != Some(workspace)
      || metadata.blocked
      || metadata.deleted_at.is_some()
      || metadata.is_workspace_root
      || key.as_str().starts_with("db$")
      || key.as_str().starts_with("userdata$")
      || !state
        .permission_service
        .get_effective_doc_role(auth.user_id, workspace, id)
        .await
        .map_err(|_| denied())?
        .can(DocAction::Read)
    {
      return Err(denied());
    }
    return Ok(Some(id));
  }
  Ok(None)
}

use myoxus_application::{
  events::WorkspaceResourceUpdates,
  workspace::resource_inventory::{WorkspaceObservation, WorkspaceResourceInventory},
};
use std::{
  collections::{HashMap, HashSet},
  sync::{Mutex, Weak},
  time::Duration,
};
use tokio::sync::watch;

pub(crate) type ObservationValue = Option<Result<Arc<WorkspaceObservation>, ()>>;

#[derive(Debug, Clone)]
struct ResourceObserver {
  inner: Arc<ObserverInner>,
}

struct ObservationGroup {
  key: Uuid,
  keys: ApiKeyService,
  actor: Uuid,
  workspace: Uuid,
  inventory: WorkspaceResourceInventory,
  max_bytes: usize,
  values: watch::Sender<ObservationValue>,
  refresh: tokio::sync::Mutex<Option<std::time::Instant>>,
}

#[derive(Default)]
struct ObserverState {
  groups: HashMap<(Uuid, Uuid), Arc<ObservationGroup>>,
  running: bool,
}

struct ObserverInner {
  updates: WorkspaceResourceUpdates,
  state: Mutex<ObserverState>,
}

impl std::fmt::Debug for ObserverInner {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.debug_struct("ResourceObserver").finish_non_exhaustive()
  }
}

impl Default for ResourceObserver {
  fn default() -> Self {
    Self::new(WorkspaceResourceUpdates::default())
  }
}

/// One key/workspace comparison is shared by all of that caller's streams.
/// The last receiver releases its group; there is no permanent background poller.
pub(crate) struct ObservationLease {
  pub(crate) values: watch::Receiver<ObservationValue>,
  key: (Uuid, Uuid),
  observer: Weak<ObserverInner>,
  group: Arc<ObservationGroup>,
}

impl ObservationLease {
  async fn refresh(&self) -> Result<Arc<WorkspaceObservation>, ()> {
    reconcile(&self.group, true).await
  }
}

async fn reconcile(group: &ObservationGroup, force: bool) -> Result<Arc<WorkspaceObservation>, ()> {
  let mut previous = group.refresh.lock().await;
  if !force
    && previous.is_some_and(|time| time.elapsed() < Duration::from_secs(1))
    && let Some(value) = group.values.borrow().clone()
  {
    return value;
  }
  let result = async {
    current_authority(&group.keys, group.key, group.actor)
      .await
      .map_err(|_| ())?;
    group
      .inventory
      .observe(group.actor, group.workspace, group.max_bytes)
      .await
      .map(Arc::new)
      .map_err(|_| ())
  }
  .await;
  *previous = Some(std::time::Instant::now());
  let value = Some(result.clone());
  // Equality is exclusively over the visible projection. A raw root revision,
  // duplicate wakeup or hidden edit cannot emit a change.
  group.values.send_if_modified(|previous| {
    if *previous == value {
      false
    } else {
      *previous = value;
      true
    }
  });
  result
}

impl Drop for ObservationLease {
  fn drop(&mut self) {
    if let Some(observer) = self.observer.upgrade() {
      let mut state = observer.state.lock().unwrap_or_else(|error| error.into_inner());
      if state
        .groups
        .get(&self.key)
        .is_some_and(|group| group.values.receiver_count() <= 1)
      {
        state.groups.remove(&self.key);
        tracing::info!(active_groups = state.groups.len(), "MCP resource observation released");
      }
    }
  }
}

impl ResourceObserver {
  fn new(updates: WorkspaceResourceUpdates) -> Self {
    Self {
      inner: Arc::new(ObserverInner {
        updates,
        state: Mutex::new(ObserverState::default()),
      }),
    }
  }

  fn observe(
    &self,
    key: Uuid,
    actor: Uuid,
    workspace: Uuid,
    keys: ApiKeyService,
    inventory: WorkspaceResourceInventory,
    max_bytes: usize,
  ) -> ObservationLease {
    let mut state = self.inner.state.lock().unwrap_or_else(|error| error.into_inner());
    let is_new = !state.groups.contains_key(&(key, workspace));
    let group = state.groups.entry((key, workspace)).or_insert_with(|| {
      let (values, _) = watch::channel(None);
      Arc::new(ObservationGroup {
        key,
        keys,
        actor,
        workspace,
        inventory,
        max_bytes,
        values,
        refresh: tokio::sync::Mutex::new(None),
      })
    });
    let values = group.values.subscribe();
    let group = group.clone();
    if is_new {
      tracing::info!(active_groups = state.groups.len(), "MCP resource observation acquired");
    }
    if !state.running {
      state.running = true;
      let observer = Arc::downgrade(&self.inner);
      let updates = self.inner.updates.subscribe();
      tokio::spawn(async move {
        Self::run(observer, updates).await;
      });
    }
    ObservationLease {
      values,
      key: (key, workspace),
      observer: Arc::downgrade(&self.inner),
      group,
    }
  }

  async fn run(observer: Weak<ObserverInner>, mut updates: broadcast::Receiver<Uuid>) {
    // Coalesce protocol-room/outbox echoes and typing bursts before querying.
    // Every fifteenth tick reconciles all groups, repairing a missed delete or
    // lost wakeup without changing durable outbox completion/claim semantics.
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut count = 0u8;
    loop {
      tick.tick().await;
      let Some(observer) = observer.upgrade() else {
        return;
      };
      let groups = {
        let mut state = observer.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.groups.is_empty() {
          state.running = false;
          return;
        }
        state.groups.values().cloned().collect::<Vec<_>>()
      };
      let mut dirty = HashSet::new();
      let mut heartbeat = count == 0;
      loop {
        match updates.try_recv() {
          Ok(workspace) => {
            dirty.insert(workspace);
          }
          Err(broadcast::error::TryRecvError::Lagged(_)) => heartbeat = true,
          Err(_) => break,
        }
      }
      count = (count + 1) % 15;
      for group in groups {
        if group.values.receiver_count() == 0 {
          continue;
        }
        if !heartbeat && !dirty.contains(&group.workspace) && group.values.borrow().is_some() {
          continue;
        }
        tokio::select! {
          _ = group.values.closed() => {},
          _ = reconcile(&group, false) => {},
        }
      }
    }
  }
}
