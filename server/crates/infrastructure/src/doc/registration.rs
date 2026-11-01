// SPDX-License-Identifier: AGPL-3.0-or-later

use myoxus_application::{
  auth::{AuthError, AuthResult},
  doc::PageRegistrationState,
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
use yjs::page_registration::{PageRegistrationProjection, PageRegistrationRequest};

use super::SqlxDocStore;

pub(super) fn parse_state(value: &str) -> AuthResult<PageRegistrationState> {
  match value {
    "legacy" => Ok(PageRegistrationState::Legacy),
    "unresolved" => Ok(PageRegistrationState::Unresolved),
    "pending" => Ok(PageRegistrationState::Pending),
    "registered" => Ok(PageRegistrationState::Registered),
    "deleted" => Ok(PageRegistrationState::Deleted),
    _ => Err(AuthError::Storage("invalid page registration evidence".into())),
  }
}

pub(super) fn normal_page(workspace_id: Uuid, key: &str) -> bool {
  key != workspace_id.to_string() && !key.starts_with("db$") && !key.starts_with("userdata$")
}

impl SqlxDocStore {
  pub(super) async fn registration_request(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    external_id: &str,
    existing_doc_id: Option<Uuid>,
  ) -> AuthResult<(PageRegistrationRequest, Option<PageRegistrationState>)> {
    if external_id == workspace_id.to_string() {
      let intents = sqlx::query_as::<_, (String, String)>(
        "SELECT external_id, creation_intent FROM page_registration_evidence WHERE workspace_id = $1 AND state = 'registered' AND creation_intent IS NOT NULL",
      ).bind(workspace_id).fetch_all(&mut **tx).await.map_err(Self::map_db_err)?;
      let retired = sqlx::query_scalar::<_, String>(
        "SELECT e.external_id FROM page_registration_evidence e
         WHERE e.workspace_id = $1 AND (e.state = 'deleted' OR NOT EXISTS (
           SELECT 1 FROM docs d WHERE d.id = e.doc_id AND d.workspace_id = e.workspace_id
         ))
         UNION SELECT r.source_id FROM workspace_content_operation_redirects r
         WHERE r.source_workspace_id = $1 AND r.source_kind = 'document'
           AND NOT EXISTS (SELECT 1 FROM docs d
             WHERE d.workspace_id = $1 AND d.external_id = r.source_id)",
      )
      .bind(workspace_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      return Ok((
        if intents.is_empty() && retired.is_empty() {
          PageRegistrationRequest::None
        } else {
          PageRegistrationRequest::Root { intents, retired }
        },
        None,
      ));
    }
    if !normal_page(workspace_id, external_id) {
      return Ok((PageRegistrationRequest::None, None));
    }
    // Legacy moved documents may have no registration receipt. Their published
    // source redirect still forbids stale cache writes from recreating them.
    if existing_doc_id.is_none()
      && sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM workspace_content_operation_redirects
         WHERE source_workspace_id = $1 AND source_kind = 'document' AND source_id = $2)",
      )
      .bind(workspace_id)
      .bind(external_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_db_err)?
    {
      tracing::info!(%workspace_id, outcome = "rejected_moved", "page registration rejected retired source identity");
      return Err(AuthError::NotFound("document".into()));
    }
    let evidence = sqlx::query_as::<_, (String, Uuid)>(
      "SELECT state, doc_id FROM page_registration_evidence WHERE workspace_id = $1 AND external_id = $2",
    )
    .bind(workspace_id)
    .bind(external_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    if evidence
      .as_ref()
      .is_some_and(|(_, doc_id)| Some(*doc_id) != existing_doc_id)
    {
      tracing::info!(%workspace_id, outcome = "rejected_stale", "page registration rejected missing or replaced identity");
      return Err(AuthError::NotFound("document".into()));
    }
    let state = evidence
      .as_ref()
      .map(|(state, _)| state.as_str())
      .map(parse_state)
      .transpose()?
      .or(existing_doc_id.map(|_| PageRegistrationState::Legacy));
    if state == Some(PageRegistrationState::Deleted) {
      tracing::info!(%workspace_id, outcome = "rejected_stale", "page registration rejected");
      return Err(AuthError::NotFound("document".into()));
    }
    Ok((
      if state == Some(PageRegistrationState::Registered) {
        PageRegistrationRequest::None
      } else {
        PageRegistrationRequest::Leaf {
          external_id: external_id.to_owned(),
        }
      },
      state,
    ))
  }

  /// Called under the existing identity and sorted root/leaf locks, before the
  /// first-write transaction commits or its byte ACK can advance a client clock.
  pub(super) async fn finish_page_registration(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    external_id: &str,
    actor_user_id: Option<Uuid>,
    prior: Option<PageRegistrationState>,
    projection: PageRegistrationProjection,
    complete: bool,
  ) -> AuthResult<Option<PageRegistrationState>> {
    if let Some(delta) = projection.root_delta {
      let root = Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta).await?;
      Self::append_workspace_doc_broadcast_outbox(
        tx,
        doc_id,
        workspace_id,
        actor_user_id,
        "page_registration",
        &[root],
      )
      .await?;
    }
    if !normal_page(workspace_id, external_id) {
      return Ok(None);
    }
    if prior == Some(PageRegistrationState::Registered) {
      return Ok(prior);
    }
    let prior_intent = sqlx::query_scalar::<_, Option<String>>(
      "SELECT creation_intent FROM page_registration_evidence WHERE workspace_id = $1 AND external_id = $2",
    )
    .bind(workspace_id)
    .bind(external_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?
    .flatten();
    if prior_intent.is_some() && projection.creation_intent.is_some() && prior_intent != projection.creation_intent {
      return Err(AuthError::InvalidInput(
        "page creation identity conflicts with persisted intent".into(),
      ));
    }
    let intent = prior_intent.clone().or(projection.creation_intent);
    if intent.is_some() {
      tracing::info!(%workspace_id, %doc_id, outcome = if prior == Some(PageRegistrationState::Pending) { "accepted_resume" } else { "accepted_create" }, "page registration accepted intent");
    }
    let mut state = if intent.is_some() {
      "pending"
    } else if prior == Some(PageRegistrationState::Legacy) {
      "legacy"
    } else {
      "unresolved"
    };
    let mut root_updates = Vec::new();
    if complete
      && (intent.is_some() || prior == Some(PageRegistrationState::Legacy))
      && let Some(title) = projection.title
    {
      let mut root = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
      if let Some(intent) = &intent
        && let Some(delta) =
          yjs::page_registration::fold_root_creation(&root, external_id, intent).map_err(AuthError::Storage)?
      {
        root_updates.push(Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta.clone()).await?);
        root = yjs::merge_updates(vec![root, delta]).map_err(AuthError::Storage)?;
      }
      let entries = yjs::extract_workspace_root_metadata(&root)
        .map_err(AuthError::Storage)?
        .pages;
      let matches: Vec<_> = entries.iter().filter(|entry| entry.id == external_id).collect();
      if matches.len() == 1 && (intent.is_some() || prior == Some(PageRegistrationState::Legacy)) {
        // Existing trash/title/order belong to the established root lifecycle.
        state = "registered";
      } else if matches.is_empty() && intent.is_some() {
        let created_at = sqlx::query_scalar("SELECT created_at FROM docs WHERE id = $1")
          .bind(doc_id)
          .fetch_one(&mut **tx)
          .await
          .map_err(Self::map_db_err)?;
        let delta = Self::create_root_page_delta(&root, external_id, &title, created_at)?;
        root_updates.push(Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta).await?);
        state = "registered";
      }
      if state == "registered"
        && let Some(intent) = &intent
      {
        let root = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
        let delta =
          yjs::page_registration::mark_root_creation(&root, external_id, intent).map_err(AuthError::Storage)?;
        root_updates.push(Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta).await?);
      }
    }
    if !root_updates.is_empty() {
      // Persistence and delivery references commit together, including the root
      // changes caused by a leaf push. A leaf ACK alone cannot deliver them.
      Self::append_workspace_doc_broadcast_outbox(
        tx,
        doc_id,
        workspace_id,
        actor_user_id,
        "page_registration",
        &root_updates,
      )
      .await?;
    }
    if prior == Some(parse_state(state)?) && prior_intent == intent {
      return Ok(prior);
    }
    sqlx::query(
      "INSERT INTO page_registration_evidence (workspace_id, external_id, doc_id, creation_intent, state) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id, external_id) DO UPDATE SET creation_intent = EXCLUDED.creation_intent, state = EXCLUDED.state",
    ).bind(workspace_id).bind(external_id).bind(doc_id).bind(intent).bind(state).execute(&mut **tx).await.map_err(Self::map_db_err)?;
    tracing::info!(%workspace_id, %doc_id, outcome = if state == "registered" { "root_confirmed" } else { state }, "page registration decision");
    Ok(Some(parse_state(state)?))
  }
}
