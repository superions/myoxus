// SPDX-License-Identifier: AGPL-3.0-or-later
//! Personal setup preferences contain references, never accepted executions.
use super::*;
use crate::graphql::auth::{AssistanceModeType, UserPreferencesType};
use myoxus_application::{auth as preferences, workspace::assistant_packages as saved};

#[derive(InputObject)]
pub struct SavedAssistantSelectionInput {
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
}
impl TryFrom<SavedAssistantSelectionInput> for saved::SavedAssistantSelectionInput {
  type Error = Error;
  fn try_from(input: SavedAssistantSelectionInput) -> Result<Self> {
    Ok(Self {
      identity: input.identity.into(),
      answers: package_answers(input.answers.0)?,
    })
  }
}

#[derive(InputObject)]
pub struct SaveAssistantSetupInput {
  pub id: ID,
  pub name: String,
  pub context: AssistantPackageContextType,
  pub package: SavedAssistantSelectionInput,
  pub project: Option<SavedAssistantSelectionInput>,
  pub setup: Option<SavedAssistantSelectionInput>,
  pub assistance_mode: Option<AssistanceModeType>,
}

#[derive(SimpleObject)]
#[graphql(name = "SavedSetupDocumentSource")]
pub struct SavedSetupDocumentSourceObjectType {
  pub component_id: String,
  pub template_id: String,
  pub version: String,
  pub digest: String,
}
#[derive(SimpleObject)]
#[graphql(name = "SavedSetupDatabaseSource")]
pub struct SavedSetupDatabaseSourceObjectType {
  pub component_id: String,
  pub definition_id: String,
}

#[derive(SimpleObject)]
#[graphql(name = "SavedAssistantSelection")]
pub struct SavedAssistantSelectionObjectType {
  pub package_id: String,
  pub defaults: Vec<AssistantNamedValueObjectType>,
  pub document_sources: Vec<SavedSetupDocumentSourceObjectType>,
  pub database_sources: Vec<SavedSetupDatabaseSourceObjectType>,
  pub workflow: Option<AssistantWorkflowIdentityObjectType>,
}

fn saved_defaults(values: BTreeMap<String, preferences::SavedSetupValue>) -> Vec<AssistantNamedValueObjectType> {
  use preferences::SavedSetupValue as V;
  values
    .into_iter()
    .map(|(input, value)| AssistantNamedValueObjectType {
      input,
      value: match value {
        V::Boolean(value) => myoxus_domain::assistant_package::AssistantValue::Boolean(value),
        V::Choice(value) => myoxus_domain::assistant_package::AssistantValue::Choice(value),
        V::Currency(value) => myoxus_domain::assistant_package::AssistantValue::Text(value),
      }
      .into(),
    })
    .collect()
}
impl From<preferences::SavedAssistantSelection> for SavedAssistantSelectionObjectType {
  fn from(value: preferences::SavedAssistantSelection) -> Self {
    Self {
      package_id: value.package_id,
      defaults: saved_defaults(value.defaults),
      document_sources: value
        .document_sources
        .into_iter()
        .map(|source| SavedSetupDocumentSourceObjectType {
          component_id: source.component_id,
          template_id: source.template_id,
          version: source.version,
          digest: source.digest,
        })
        .collect(),
      database_sources: value
        .database_sources
        .into_iter()
        .map(|source| SavedSetupDatabaseSourceObjectType {
          component_id: source.component_id,
          definition_id: source.definition_id,
        })
        .collect(),
      workflow: value.workflow.map(|source| AssistantWorkflowIdentityObjectType {
        id: source.id,
        version: source.version,
        digest: source.digest,
      }),
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "SavedSetupConfiguration")]
pub struct SavedSetupConfigurationObjectType {
  pub id: ID,
  pub name: String,
  pub context: AssistantPackageContextType,
  pub package: SavedAssistantSelectionObjectType,
  pub project: Option<SavedAssistantSelectionObjectType>,
  pub setup: Option<SavedAssistantSelectionObjectType>,
  pub assistance_mode: Option<AssistanceModeType>,
}
impl From<preferences::SavedSetupConfiguration> for SavedSetupConfigurationObjectType {
  fn from(value: preferences::SavedSetupConfiguration) -> Self {
    Self {
      id: ID(value.id.to_string()),
      name: value.name,
      context: value.context.into(),
      package: value.package.into(),
      project: value.project.map(Into::into),
      setup: value.setup.map(Into::into),
      assistance_mode: value.assistance_mode.map(Into::into),
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "SavedSetupClearReason", rename_items = "PascalCase")]
pub enum SavedSetupClearReasonType {
  PackageUnavailable,
  InputUnavailable,
  ValueUnavailable,
  SourceUnavailable,
  WorkflowUnavailable,
  NewComponent,
}
#[derive(SimpleObject)]
#[graphql(name = "SavedSetupClearedValue")]
pub struct SavedSetupClearedValueObjectType {
  pub input_id: Option<String>,
  pub component_id: Option<String>,
  pub reason: SavedSetupClearReasonType,
}
#[derive(SimpleObject)]
#[graphql(name = "ResolvedSavedAssistantSelection")]
pub struct ResolvedSavedAssistantSelectionObjectType {
  pub descriptor: Option<AssistantPackageObjectType>,
  pub defaults: Vec<AssistantNamedValueObjectType>,
  pub cleared: Vec<SavedSetupClearedValueObjectType>,
  pub unavailable: bool,
}
impl From<saved::ResolvedSavedAssistantSelection> for ResolvedSavedAssistantSelectionObjectType {
  fn from(value: saved::ResolvedSavedAssistantSelection) -> Self {
    Self {
      descriptor: value.descriptor.map(Into::into),
      defaults: saved_defaults(value.defaults),
      unavailable: value.unavailable,
      cleared: value
        .cleared
        .into_iter()
        .map(|cleared| SavedSetupClearedValueObjectType {
          input_id: cleared.input_id,
          component_id: cleared.component_id,
          reason: match cleared.reason {
            saved::SavedSetupClearReason::PackageUnavailable => SavedSetupClearReasonType::PackageUnavailable,
            saved::SavedSetupClearReason::InputUnavailable => SavedSetupClearReasonType::InputUnavailable,
            saved::SavedSetupClearReason::ValueUnavailable => SavedSetupClearReasonType::ValueUnavailable,
            saved::SavedSetupClearReason::SourceUnavailable => SavedSetupClearReasonType::SourceUnavailable,
            saved::SavedSetupClearReason::WorkflowUnavailable => SavedSetupClearReasonType::WorkflowUnavailable,
            saved::SavedSetupClearReason::NewComponent => SavedSetupClearReasonType::NewComponent,
          },
        })
        .collect(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "SavedSetupResolution")]
pub struct SavedSetupResolutionObjectType {
  pub configuration: SavedSetupConfigurationObjectType,
  pub package: ResolvedSavedAssistantSelectionObjectType,
  pub project: Option<ResolvedSavedAssistantSelectionObjectType>,
  pub setup: Option<ResolvedSavedAssistantSelectionObjectType>,
  pub unavailable: bool,
}
impl From<saved::SavedSetupResolution> for SavedSetupResolutionObjectType {
  fn from(value: saved::SavedSetupResolution) -> Self {
    Self {
      configuration: value.configuration.into(),
      package: value.package.into(),
      project: value.project.map(Into::into),
      setup: value.setup.map(Into::into),
      unavailable: value.unavailable,
    }
  }
}

fn saved_setup_id(id: &ID) -> Result<Uuid> {
  Uuid::parse_str(id.as_str())
    .ok()
    .filter(|id| !id.is_nil())
    .ok_or_else(|| map_gql_error(preferences::AuthError::InvalidInput("invalid saved setup ID".into())))
}
pub(crate) async fn save_assistant_setup(
  ctx: &Context<'_>,
  expected_user_id: ID,
  input: SaveAssistantSetupInput,
) -> Result<UserPreferencesType> {
  let (state, snapshot) = require_session(ctx).await?;
  saved_setup_owner(snapshot.user.id, &expected_user_id)?;
  let captured = package_service(&state)?
    .capture_saved_setup(
      snapshot.user.id,
      saved::SavedSetupCaptureInput {
        id: saved_setup_id(&input.id)?,
        name: input.name,
        context: input.context.into(),
        package: input.package.try_into()?,
        project: input.project.map(TryInto::try_into).transpose()?,
        setup: input.setup.map(TryInto::try_into).transpose()?,
        assistance_mode: input.assistance_mode.map(Into::into),
      },
      state.auth(),
    )
    .await
    .map_err(map_database_error)?;
  // Capture has no effects. One existing preference transaction owns the only
  // write; saved mode never becomes the account's active assistance mode.
  let record = state
    .auth()
    .patch_user_preferences(
      snapshot.user.id,
      preferences::UserPreferencesPatch {
        saved_setups: vec![preferences::SavedSetupPatch {
          id: captured.id,
          value: Some(captured),
        }],
        ..Default::default()
      },
    )
    .await
    .map_err(map_gql_error)?;
  Ok(crate::graphql::auth::user::map_user_preferences(&state, record).await)
}
pub(crate) async fn delete_assistant_setup(
  ctx: &Context<'_>,
  expected_user_id: ID,
  id: ID,
) -> Result<UserPreferencesType> {
  let (state, snapshot) = require_session(ctx).await?;
  saved_setup_owner(snapshot.user.id, &expected_user_id)?;
  let record = state
    .auth()
    .patch_user_preferences(
      snapshot.user.id,
      preferences::UserPreferencesPatch {
        saved_setups: vec![preferences::SavedSetupPatch {
          id: saved_setup_id(&id)?,
          value: None,
        }],
        ..Default::default()
      },
    )
    .await
    .map_err(map_gql_error)?;
  Ok(crate::graphql::auth::user::map_user_preferences(&state, record).await)
}

/// A browser cookie may switch before the cached account catches up. Reject
/// that stale writer before either source capture or the preference transaction.
fn saved_setup_owner(actor: Uuid, expected_user_id: &ID) -> Result<()> {
  if saved_setup_id(expected_user_id)? != actor {
    return Err(map_gql_error(preferences::AuthError::ActionForbidden));
  }
  Ok(())
}
pub(crate) async fn resolve_saved_assistant_setup(
  ctx: &Context<'_>,
  actor: Uuid,
  id: ID,
) -> Result<Option<SavedSetupResolutionObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  if snapshot.user.id != actor {
    return Err(map_gql_error(preferences::AuthError::ActionForbidden));
  }
  let id = saved_setup_id(&id)?;
  let record = state.auth().get_user_preferences(actor).await.map_err(map_gql_error)?;
  let Some(configuration) = record.values.saved_setups.get(&id) else {
    return Ok(None);
  };
  package_service(&state)?
    .resolve_saved_setup(actor, configuration)
    .await
    .map(Into::into)
    .map(Some)
    .map_err(map_database_error)
}
