//! GraphQL Copilot resolvers: session creation, transcript listing, and
//! provider-quota stubs required for API compatibility.
//!
//! Exposes Copilot functionality as `CopilotQuery` and `CopilotMutation`
//! sub-objects on the authenticated GraphQL root. All session-management
//! resolvers delegate to `myoxus_application::copilot::CopilotService`.

use std::sync::Arc;

use async_graphql::{Context, Object, Result};
use myoxus_application::auth::AuthError;
use myoxus_domain::entities::CopilotContext;
use uuid::Uuid;

use crate::graphql::utils::map_gql_error;
use crate::graphql::{CopilotContextType, TranscriptionResultType};
use crate::state::ApiState;

use super::{
  ChatHistoryOrderType, CopilotHistoriesTypeEdge, CopilotModelType, CopilotModelsType, CopilotQuotaType, CopilotType,
  PageInfoType, PaginatedCopilotHistoriesType, PaginationInputType, QueryChatHistoriesInput,
  assert_copilot_session_access, assert_copilot_workspace_access, map_copilot_history, map_copilot_message,
};

fn map_context(context: CopilotContext) -> CopilotContextType {
  CopilotContextType {
    id: context.id.to_string(),
    workspace_id: context.workspace_id.map(|value| value.to_string()),
    name: context.name,
    created_at: context.created_at.timestamp_millis(),
  }
}

#[Object]
impl CopilotType {
  async fn quota(&self) -> &CopilotQuotaType {
    &self.quota
  }

  /// Token usage — same shape as quota. The web frontend's currentUser profile
  /// fragment queries `copilot { tokens { limit used } }`.
  async fn tokens(&self) -> &CopilotQuotaType {
    &self.quota
  }

  async fn models(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "promptName")] _prompt_name: String,
  ) -> Result<CopilotModelsType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    let model_ids = state.config.copilot.chat_models();
    // Keep the deployed non-null String field: empty means no configured model,
    // paired with an empty optionalModels list, never a fabricated provider ID.
    let default_model = model_ids.first().cloned().unwrap_or_default();
    let optional_models = model_ids
      .into_iter()
      .map(|model| CopilotModelType {
        supports_vision: state.config.copilot.chat_providers().into_iter().any(|(_, provider)| {
          provider.models.contains(&model)
            && provider
              .model_options
              .get(&model)
              .is_some_and(|options| options.supports_vision)
        }),
        reasoning_available: state.config.copilot.chat_providers().into_iter().any(|(_, provider)| {
          provider.models.contains(&model)
            && provider
              .model_options
              .get(&model)
              .is_some_and(|options| options.reasoning_control.is_some())
        }),
        id: model.clone(),
        name: model,
      })
      .collect::<Vec<_>>();

    Ok(CopilotModelsType {
      default_model,
      optional_models,
      pro_models: Vec::new(),
    })
  }

  /// List copilot contexts, optionally filtered by session or context ID.
  ///
  /// P25-A-28/29: `copilot { contexts(sessionId, contextId) }`
  async fn contexts(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "sessionId")] session_id: Option<String>,
    #[graphql(name = "contextId")] context_id: Option<String>,
  ) -> Result<Vec<CopilotContextType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;

    if let Some(workspace_id) = self.workspace_id {
      assert_copilot_workspace_access(state, self.user_id, workspace_id, "copilot.contexts").await?;
    }

    let copilot = state.copilot();
    let mut context_workspace = self.workspace_id;

    if let Some(sid) = session_id.as_deref() {
      let session_id = Uuid::parse_str(sid).map_err(|_| "Invalid session id")?;
      let session = copilot.get_session(session_id).await.map_err(map_gql_error)?;
      if self
        .workspace_id
        .is_some_and(|workspace_id| session.workspace_id != Some(workspace_id))
      {
        return Err(map_gql_error(myoxus_application::auth::AuthError::ActionForbidden));
      }
      assert_copilot_session_access(state, self.user_id, &session, "copilot.contexts").await?;
      context_workspace = session.workspace_id;
    }

    // If a specific context_id is given, return just that one (owned by user)
    if let Some(cid) = context_id {
      let context_uuid = Uuid::parse_str(&cid).map_err(|_| "Invalid context id")?;
      let context =
        crate::graphql::ensure_context_owned(state, self.user_id, context_uuid, context_workspace, false).await?;
      return Ok(
        context
          .filter(|context| context.user_id == self.user_id)
          .map(map_context)
          .into_iter()
          .collect(),
      );
    }

    // Exact native lookup uses the same deployed name as context creation;
    // never search only a bounded inventory page for a selected session.
    if let Some(sid) = session_id {
      let Some(workspace_id) = context_workspace else {
        return Ok(Vec::new());
      };
      let session_context_name = format!("session-{sid}");
      let context = copilot
        .find_context(self.user_id, workspace_id, &session_context_name)
        .await
        .map_err(map_gql_error)?;
      if let Some(context) = &context {
        crate::graphql::ensure_context_owned(state, self.user_id, context.id, context_workspace, true).await?;
      }
      return Ok(context.map(map_context).into_iter().collect());
    }

    // Each stored scope is checked even for an unscoped inventory request.
    let contexts = copilot
      .list_contexts(self.user_id, self.workspace_id, 200, 0)
      .await
      .map_err(map_gql_error)?;
    let mut result = Vec::with_capacity(contexts.len());
    for context in contexts {
      crate::graphql::ensure_context_owned(state, self.user_id, context.id, self.workspace_id, true).await?;
      result.push(map_context(context));
    }
    Ok(result)
  }

  /// List audio transcription jobs.
  ///
  /// P25-A-45: `copilot(workspaceId) { audioTranscription(jobId?, blobId?) }`
  #[graphql(name = "audioTranscription")]
  async fn audio_transcription(
    &self,
    ctx: &Context<'_>,
    #[graphql(name = "jobId")] job_id: Option<String>,
    #[graphql(name = "blobId")] blob_id: Option<String>,
  ) -> Result<Vec<TranscriptionResultType>> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;

    let job_id = job_id
      .map(|id| Uuid::parse_str(&id))
      .transpose()
      .map_err(|_| "Invalid job id")?;
    let results = state
      .transcription_results()
      .query(
        myoxus_domain::transcription::TranscriptionResultQuery {
          user_id: self.user_id,
          workspace_id: self.workspace_id,
          job_id,
          blob_id,
        },
        &state.permission_service(),
      )
      .await
      .map_err(map_gql_error)?;
    Ok(
      results
        .into_iter()
        .map(crate::graphql::copilot_helpers::project_audio_job_result)
        .collect(),
    )
  }

  #[graphql(name = "chats")]
  async fn chats(
    &self,
    ctx: &Context<'_>,
    pagination: PaginationInputType,
    doc_id: Option<String>,
    options: Option<QueryChatHistoriesInput>,
  ) -> Result<PaginatedCopilotHistoriesType> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    let copilot = state.copilot();

    let workspace_id = self.workspace_id;

    let options = options.unwrap_or_default();
    let mut limit = pagination.first.unwrap_or(20).max(1) as i64;
    let mut offset = pagination.offset.unwrap_or(0).max(0) as i64;
    if let Some(value) = options.limit {
      limit = value.max(1) as i64;
    }
    if let Some(value) = options.skip {
      offset = value.max(0) as i64;
    }

    if let Some(workspace_id) = workspace_id {
      assert_copilot_workspace_access(state, self.user_id, workspace_id, "copilot.chats").await?;
    }

    let mut filter = myoxus_domain::entities::CopilotSessionFilter {
      workspace_id,
      session_id: options
        .session_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| "Invalid session id")?,
      pinned: options.pinned,
      action: options.action,
      fork: options.fork,
      include_archived: true,
      ascending: !options.session_order.unwrap_or(ChatHistoryOrderType::Desc).is_desc(),
      ..Default::default()
    };
    if let Some(target_doc_id) = doc_id {
      let workspace_id = workspace_id.ok_or("Workspace id required for document chats")?;
      let target_doc_id = match crate::graphql::utils::resolve_doc_id(state, workspace_id, &target_doc_id).await {
        Ok(id) => id,
        Err(error) => {
          let name = error.extensions.as_ref().and_then(|extensions| extensions.get("name"));
          // Unknown/invalid keys have historically meant no matching chats.
          // Storage failures must remain failures, not successful empty history.
          if name != Some(&async_graphql::Value::from("NOT_FOUND"))
            && name != Some(&async_graphql::Value::from("INVALID_INPUT"))
          {
            return Err(error);
          }
          return Ok(PaginatedCopilotHistoriesType {
            total_count: 0,
            edges: Vec::new(),
            page_info: PageInfoType {
              has_next_page: false,
              has_previous_page: false,
              start_cursor: None,
              end_cursor: None,
            },
          });
        }
      };
      filter.doc_id = Some(target_doc_id);
    }
    let page = copilot
      .list_sessions(self.user_id, &filter, limit, offset)
      .await
      .map_err(map_gql_error)?;
    // The repository enforces ownership/deletion and returns distinct targets
    // from every match, not just the page. An unreadable off-page match must
    // still fail closed before any count or content is exposed to the caller.
    let mut checked_workspaces = std::collections::HashSet::new();
    for scope in &page.access_scopes {
      let workspace = scope
        .workspace_id
        .ok_or_else(|| map_gql_error(AuthError::ActionForbidden))?;
      if checked_workspaces.insert(workspace) {
        assert_copilot_workspace_access(state, self.user_id, workspace, "copilot.chats").await?;
      }
      if let Some(doc) = scope.doc_id {
        super::assert_copilot_doc_access(state, self.user_id, workspace, doc).await?;
      }
    }
    let total_count = i32::try_from(page.total_count).map_err(|_| "Copilot history count exceeds API range")?;
    let page_sessions = page.sessions;
    let has_next_page = offset + (page_sessions.len() as i64) < page.total_count;
    let with_messages = options.with_messages.unwrap_or(true);
    let message_desc = options.message_order.unwrap_or(ChatHistoryOrderType::Asc).is_desc();

    let mut document_ids_by_workspace = std::collections::HashMap::<Uuid, Vec<Uuid>>::new();
    for session in &page_sessions {
      if let (Some(workspace), Some(doc)) = (session.workspace_id, session.doc_id) {
        document_ids_by_workspace.entry(workspace).or_default().push(doc);
      }
    }
    let mut doc_keys = std::collections::HashMap::new();
    for (workspace, ids) in document_ids_by_workspace {
      doc_keys.extend(
        state
          .doc()
          .resolve_external_doc_ids(workspace, &ids)
          .await
          .map_err(map_gql_error)?,
      );
    }

    let mut edges = Vec::with_capacity(page_sessions.len());
    for session in page_sessions {
      let mut messages = if with_messages {
        if options.session_id.is_some() {
          // Exact native history/reconciliation must include the actual last
          // turn, not only the oldest public message page. Lists stay bounded.
          copilot.generation_messages(session.id).await.map_err(map_gql_error)?
        } else {
          copilot.list_messages(session.id, 500, 0).await.map_err(map_gql_error)?
        }
      } else {
        Vec::new()
      };
      messages.sort_by_key(|message| message.created_at);
      if message_desc {
        messages.reverse();
      }

      let workspace_id = session
        .workspace_id
        .or(self.workspace_id)
        .ok_or("Workspace id required for copilot chats")?;
      let mapped_messages = messages
        .into_iter()
        .map(|message| map_copilot_message(message, workspace_id))
        .collect::<Vec<_>>();

      edges.push(CopilotHistoriesTypeEdge {
        cursor: session.id.to_string(),
        node: map_copilot_history(session, workspace_id, mapped_messages, &doc_keys)?,
      });
    }

    let has_previous_page = offset > 0 && total_count > 0;
    let start_cursor = edges.first().map(|edge| edge.cursor.clone());
    let end_cursor = edges.last().map(|edge| edge.cursor.clone());

    Ok(PaginatedCopilotHistoriesType {
      total_count,
      edges,
      page_info: PageInfoType {
        has_next_page,
        has_previous_page,
        start_cursor,
        end_cursor,
      },
    })
  }
}
