//! GraphQL types for the `error(name: ErrorNames!)` introspection query.
//!
//! Provides structured error metadata so clients can discover known error codes.
//! Each `ErrorNames` variant maps to a member of `ErrorDataUnion` which carries
//! the error's message template and type classification.

use async_graphql::{Enum, Object, Union};

/// All known error names in the API — mirrors the upstream AFFiNE schema.
///
/// The frontend imports this enum for pattern-matching on error responses.
#[derive(Enum, Debug, Copy, Clone, Eq, PartialEq)]
pub enum ErrorNames {
  #[graphql(name = "ACCESS_DENIED")]
  AccessDenied,
  #[graphql(name = "ACTION_FORBIDDEN")]
  ActionForbidden,
  #[graphql(name = "ALREADY_IN_SPACE")]
  AlreadyInSpace,
  #[graphql(name = "AUTHENTICATION_REQUIRED")]
  AuthenticationRequired,
  #[graphql(name = "BAD_REQUEST")]
  BadRequest,
  #[graphql(name = "BLOB_INVALID")]
  BlobInvalid,
  #[graphql(name = "BLOB_NOT_FOUND")]
  BlobNotFound,
  #[graphql(name = "BLOB_QUOTA_EXCEEDED")]
  BlobQuotaExceeded,
  #[graphql(name = "CALENDAR_PROVIDER_REQUEST_ERROR")]
  CalendarProviderRequestError,
  #[graphql(name = "CANNOT_DELETE_ALL_ADMIN_ACCOUNT")]
  CannotDeleteAllAdminAccount,
  #[graphql(name = "CANNOT_DELETE_OWN_ACCOUNT")]
  CannotDeleteOwnAccount,
  #[graphql(name = "CANT_UPDATE_ONETIME_PAYMENT_SUBSCRIPTION")]
  CantUpdateOnetimePaymentSubscription,
  #[graphql(name = "CAN_NOT_BATCH_GRANT_DOC_OWNER_PERMISSIONS")]
  CanNotBatchGrantDocOwnerPermissions,
  #[graphql(name = "CAN_NOT_REVOKE_YOURSELF")]
  CanNotRevokeYourself,
  #[graphql(name = "CAPTCHA_VERIFICATION_FAILED")]
  CaptchaVerificationFailed,
  #[graphql(name = "COMMENT_ATTACHMENT_NOT_FOUND")]
  CommentAttachmentNotFound,
  #[graphql(name = "COMMENT_ATTACHMENT_QUOTA_EXCEEDED")]
  CommentAttachmentQuotaExceeded,
  #[graphql(name = "COMMENT_NOT_FOUND")]
  CommentNotFound,
  #[graphql(name = "COPILOT_ACTION_TAKEN")]
  CopilotActionTaken,
  #[graphql(name = "COPILOT_CONTEXT_FILE_NOT_SUPPORTED")]
  CopilotContextFileNotSupported,
  #[graphql(name = "COPILOT_DOCS_NOT_FOUND")]
  CopilotDocsNotFound,
  #[graphql(name = "COPILOT_DOC_NOT_FOUND")]
  CopilotDocNotFound,
  #[graphql(name = "COPILOT_EMBEDDING_DISABLED")]
  CopilotEmbeddingDisabled,
  #[graphql(name = "COPILOT_EMBEDDING_UNAVAILABLE")]
  CopilotEmbeddingUnavailable,
  #[graphql(name = "COPILOT_FAILED_TO_ADD_WORKSPACE_FILE_EMBEDDING")]
  CopilotFailedToAddWorkspaceFileEmbedding,
  #[graphql(name = "COPILOT_FAILED_TO_CREATE_MESSAGE")]
  CopilotFailedToCreateMessage,
  #[graphql(name = "COPILOT_FAILED_TO_GENERATE_EMBEDDING")]
  CopilotFailedToGenerateEmbedding,
  #[graphql(name = "COPILOT_FAILED_TO_GENERATE_TEXT")]
  CopilotFailedToGenerateText,
  #[graphql(name = "COPILOT_FAILED_TO_MATCH_CONTEXT")]
  CopilotFailedToMatchContext,
  #[graphql(name = "COPILOT_FAILED_TO_MATCH_GLOBAL_CONTEXT")]
  CopilotFailedToMatchGlobalContext,
  #[graphql(name = "COPILOT_FAILED_TO_MODIFY_CONTEXT")]
  CopilotFailedToModifyContext,
  #[graphql(name = "COPILOT_INVALID_CONTEXT")]
  CopilotInvalidContext,
  #[graphql(name = "COPILOT_MESSAGE_NOT_FOUND")]
  CopilotMessageNotFound,
  #[graphql(name = "COPILOT_PROMPT_INVALID")]
  CopilotPromptInvalid,
  #[graphql(name = "COPILOT_PROMPT_NOT_FOUND")]
  CopilotPromptNotFound,
  #[graphql(name = "COPILOT_PROVIDER_NOT_SUPPORTED")]
  CopilotProviderNotSupported,
  #[graphql(name = "COPILOT_PROVIDER_SIDE_ERROR")]
  CopilotProviderSideError,
  #[graphql(name = "COPILOT_QUOTA_EXCEEDED")]
  CopilotQuotaExceeded,
  #[graphql(name = "COPILOT_SESSION_DELETED")]
  CopilotSessionDeleted,
  #[graphql(name = "COPILOT_SESSION_INVALID_INPUT")]
  CopilotSessionInvalidInput,
  #[graphql(name = "COPILOT_SESSION_NOT_FOUND")]
  CopilotSessionNotFound,
  #[graphql(name = "COPILOT_TRANSCRIPTION_AUDIO_NOT_PROVIDED")]
  CopilotTranscriptionAudioNotProvided,
  #[graphql(name = "COPILOT_TRANSCRIPTION_JOB_EXISTS")]
  CopilotTranscriptionJobExists,
  #[graphql(name = "COPILOT_TRANSCRIPTION_JOB_NOT_FOUND")]
  CopilotTranscriptionJobNotFound,
  #[graphql(name = "CUSTOMER_PORTAL_CREATE_FAILED")]
  CustomerPortalCreateFailed,
  #[graphql(name = "DOC_ACTION_DENIED")]
  DocActionDenied,
  #[graphql(name = "DOC_DEFAULT_ROLE_CAN_NOT_BE_OWNER")]
  DocDefaultRoleCanNotBeOwner,
  #[graphql(name = "DOC_HISTORY_NOT_FOUND")]
  DocHistoryNotFound,
  #[graphql(name = "DOC_IS_NOT_PUBLIC")]
  DocIsNotPublic,
  #[graphql(name = "DOC_NOT_FOUND")]
  DocNotFound,
  #[graphql(name = "DOC_UPDATE_BLOCKED")]
  DocUpdateBlocked,
  #[graphql(name = "EMAIL_ALREADY_USED")]
  EmailAlreadyUsed,
  #[graphql(name = "EMAIL_SERVICE_NOT_CONFIGURED")]
  EmailServiceNotConfigured,
  #[graphql(name = "EMAIL_TOKEN_NOT_FOUND")]
  EmailTokenNotFound,
  #[graphql(name = "EMAIL_VERIFICATION_REQUIRED")]
  EmailVerificationRequired,
  #[graphql(name = "EXPECT_TO_GRANT_DOC_USER_ROLES")]
  ExpectToGrantDocUserRoles,
  #[graphql(name = "EXPECT_TO_PUBLISH_DOC")]
  ExpectToPublishDoc,
  #[graphql(name = "EXPECT_TO_REVOKE_DOC_USER_ROLES")]
  ExpectToRevokeDocUserRoles,
  #[graphql(name = "EXPECT_TO_REVOKE_PUBLIC_DOC")]
  ExpectToRevokePublicDoc,
  #[graphql(name = "EXPECT_TO_UPDATE_DOC_USER_ROLE")]
  ExpectToUpdateDocUserRole,
  #[graphql(name = "FAILED_TO_CHECKOUT")]
  FailedToCheckout,
  #[graphql(name = "FAILED_TO_SAVE_UPDATES")]
  FailedToSaveUpdates,
  #[graphql(name = "FAILED_TO_UPSERT_SNAPSHOT")]
  FailedToUpsertSnapshot,
  #[graphql(name = "GRAPHQL_BAD_REQUEST")]
  GraphqlBadRequest,
  #[graphql(name = "HTTP_REQUEST_ERROR")]
  HttpRequestError,
  #[graphql(name = "INTERNAL_SERVER_ERROR")]
  InternalServerError,
  #[graphql(name = "INVALID_APP_CONFIG")]
  InvalidAppConfig,
  #[graphql(name = "INVALID_APP_CONFIG_INPUT")]
  InvalidAppConfigInput,
  #[graphql(name = "INVALID_AUTH_STATE")]
  InvalidAuthState,
  #[graphql(name = "INVALID_CHECKOUT_PARAMETERS")]
  InvalidCheckoutParameters,
  #[graphql(name = "INVALID_EMAIL")]
  InvalidEmail,
  #[graphql(name = "INVALID_EMAIL_TOKEN")]
  InvalidEmailToken,
  #[graphql(name = "INVALID_HISTORY_TIMESTAMP")]
  InvalidHistoryTimestamp,
  #[graphql(name = "INVALID_INDEXER_INPUT")]
  InvalidIndexerInput,
  #[graphql(name = "INVALID_INVITATION")]
  InvalidInvitation,
  #[graphql(name = "INVALID_LICENSE_SESSION_ID")]
  InvalidLicenseSessionId,
  #[graphql(name = "INVALID_LICENSE_TO_ACTIVATE")]
  InvalidLicenseToActivate,
  #[graphql(name = "INVALID_LICENSE_UPDATE_PARAMS")]
  InvalidLicenseUpdateParams,
  #[graphql(name = "INVALID_OAUTH_CALLBACK_CODE")]
  InvalidOauthCallbackCode,
  #[graphql(name = "INVALID_OAUTH_CALLBACK_STATE")]
  InvalidOauthCallbackState,
  #[graphql(name = "INVALID_OAUTH_RESPONSE")]
  InvalidOauthResponse,
  #[graphql(name = "INVALID_PASSWORD_LENGTH")]
  InvalidPasswordLength,
  #[graphql(name = "INVALID_RUNTIME_CONFIG_TYPE")]
  InvalidRuntimeConfigType,
  #[graphql(name = "INVALID_SEARCH_PROVIDER_REQUEST")]
  InvalidSearchProviderRequest,
  #[graphql(name = "INVALID_SUBSCRIPTION_PARAMETERS")]
  InvalidSubscriptionParameters,
  #[graphql(name = "LICENSE_EXPIRED")]
  LicenseExpired,
  #[graphql(name = "LICENSE_NOT_FOUND")]
  LicenseNotFound,
  #[graphql(name = "LICENSE_REVEALED")]
  LicenseRevealed,
  #[graphql(name = "LINK_EXPIRED")]
  LinkExpired,
  #[graphql(name = "MAILER_SERVICE_IS_NOT_CONFIGURED")]
  MailerServiceIsNotConfigured,
  #[graphql(name = "MANAGED_BY_APP_STORE_OR_PLAY")]
  ManagedByAppStoreOrPlay,
  #[graphql(name = "MEMBER_NOT_FOUND_IN_SPACE")]
  MemberNotFoundInSpace,
  #[graphql(name = "MEMBER_QUOTA_EXCEEDED")]
  MemberQuotaExceeded,
  #[graphql(name = "MENTION_USER_DOC_ACCESS_DENIED")]
  MentionUserDocAccessDenied,
  #[graphql(name = "MENTION_USER_ONESELF_DENIED")]
  MentionUserOneselfDenied,
  #[graphql(name = "MISSING_OAUTH_QUERY_PARAMETER")]
  MissingOauthQueryParameter,
  #[graphql(name = "NETWORK_ERROR")]
  NetworkError,
  #[graphql(name = "NEW_OWNER_IS_NOT_ACTIVE_MEMBER")]
  NewOwnerIsNotActiveMember,
  #[graphql(name = "NOTIFICATION_NOT_FOUND")]
  NotificationNotFound,
  #[graphql(name = "NOT_FOUND")]
  NotFound,
  #[graphql(name = "NOT_IN_SPACE")]
  NotInSpace,
  #[graphql(name = "NO_COPILOT_PROVIDER_AVAILABLE")]
  NoCopilotProviderAvailable,
  #[graphql(name = "NO_MORE_SEAT")]
  NoMoreSeat,
  #[graphql(name = "OAUTH_ACCOUNT_ALREADY_CONNECTED")]
  OauthAccountAlreadyConnected,
  #[graphql(name = "OAUTH_STATE_EXPIRED")]
  OauthStateExpired,
  #[graphql(name = "OWNER_CAN_NOT_LEAVE_WORKSPACE")]
  OwnerCanNotLeaveWorkspace,
  #[graphql(name = "PASSWORD_REQUIRED")]
  PasswordRequired,
  #[graphql(name = "QUERY_TOO_LONG")]
  QueryTooLong,
  #[graphql(name = "REPLY_NOT_FOUND")]
  ReplyNotFound,
  #[graphql(name = "RESPONSE_TOO_LARGE_ERROR")]
  ResponseTooLargeError,
  #[graphql(name = "RUNTIME_CONFIG_NOT_FOUND")]
  RuntimeConfigNotFound,
  #[graphql(name = "SAME_EMAIL_PROVIDED")]
  SameEmailProvided,
  #[graphql(name = "SAME_SUBSCRIPTION_RECURRING")]
  SameSubscriptionRecurring,
  #[graphql(name = "SEARCH_PROVIDER_NOT_FOUND")]
  SearchProviderNotFound,
  #[graphql(name = "SIGN_UP_FORBIDDEN")]
  SignUpForbidden,
  #[graphql(name = "SPACE_ACCESS_DENIED")]
  SpaceAccessDenied,
  #[graphql(name = "SPACE_NOT_FOUND")]
  SpaceNotFound,
  #[graphql(name = "SPACE_OWNER_NOT_FOUND")]
  SpaceOwnerNotFound,
  #[graphql(name = "SPACE_SHOULD_HAVE_ONLY_ONE_OWNER")]
  SpaceShouldHaveOnlyOneOwner,
  #[graphql(name = "SSRF_BLOCKED_ERROR")]
  SsrfBlockedError,
  #[graphql(name = "STORAGE_QUOTA_EXCEEDED")]
  StorageQuotaExceeded,
  #[graphql(name = "SUBSCRIPTION_ALREADY_EXISTS")]
  SubscriptionAlreadyExists,
  #[graphql(name = "SUBSCRIPTION_EXPIRED")]
  SubscriptionExpired,
  #[graphql(name = "SUBSCRIPTION_HAS_BEEN_CANCELED")]
  SubscriptionHasBeenCanceled,
  #[graphql(name = "SUBSCRIPTION_HAS_NOT_BEEN_CANCELED")]
  SubscriptionHasNotBeenCanceled,
  #[graphql(name = "SUBSCRIPTION_NOT_EXISTS")]
  SubscriptionNotExists,
  #[graphql(name = "SUBSCRIPTION_PLAN_NOT_FOUND")]
  SubscriptionPlanNotFound,
  #[graphql(name = "TOO_MANY_REQUEST")]
  TooManyRequest,
  #[graphql(name = "UNKNOWN_OAUTH_PROVIDER")]
  UnknownOauthProvider,
  #[graphql(name = "UNSPLASH_IS_NOT_CONFIGURED")]
  UnsplashIsNotConfigured,
  #[graphql(name = "UNSUPPORTED_CLIENT_VERSION")]
  UnsupportedClientVersion,
  #[graphql(name = "UNSUPPORTED_SUBSCRIPTION_PLAN")]
  UnsupportedSubscriptionPlan,
  #[graphql(name = "USER_AVATAR_NOT_FOUND")]
  UserAvatarNotFound,
  #[graphql(name = "USER_NOT_FOUND")]
  UserNotFound,
  #[graphql(name = "VALIDATION_ERROR")]
  ValidationError,
  #[graphql(name = "VERSION_REJECTED")]
  VersionRejected,
  #[graphql(name = "WORKSPACE_ID_REQUIRED_FOR_TEAM_SUBSCRIPTION")]
  WorkspaceIdRequiredForTeamSubscription,
  #[graphql(name = "WORKSPACE_ID_REQUIRED_TO_UPDATE_TEAM_SUBSCRIPTION")]
  WorkspaceIdRequiredToUpdateTeamSubscription,
  #[graphql(name = "WORKSPACE_LICENSE_ALREADY_EXISTS")]
  WorkspaceLicenseAlreadyExists,
  #[graphql(name = "WORKSPACE_PERMISSION_NOT_FOUND")]
  WorkspacePermissionNotFound,
  #[graphql(name = "WRONG_SIGN_IN_CREDENTIALS")]
  WrongSignInCredentials,
  #[graphql(name = "WRONG_SIGN_IN_METHOD")]
  WrongSignInMethod,
}

// ─── ErrorDataUnion ─────────────────────────────────────────────────────────
//
// The legacy schema defines ~60 separate data types (one per error) and a union
// of all of them.  The frontend's generated schema.ts types reference these but
// no `.gql` operation file actually sends the `error(name:)` query at runtime.
//
// For schema compatibility we expose the full union.  Each member type carries
// a `message` field (always present in the legacy) plus type-specific context
// fields.  For errors whose data type only has `message`, we group them under
// `GraphqlBadRequestDataType` as a catch-all — the resolver dispatches based on
// the ErrorNames variant.
//
// Member types are listed in the same order as the frontend's `ErrorDataUnion`.

/// Common message-only error data.
pub struct GraphqlBadRequestDataType {
  pub code: String,
  pub message: String,
}

#[Object]
impl GraphqlBadRequestDataType {
  async fn code(&self) -> &str {
    &self.code
  }
  async fn message(&self) -> &str {
    &self.message
  }
}

// ── Typed data types matching the legacy schema ────────────────────────────
// Each struct below corresponds to one member of the upstream ErrorDataUnion.
// We implement them with `#[Object]` so they can participate in the union.

macro_rules! error_data_type {
  // Pattern: single `message: String` field
  (msg $Name:ident) => {
    pub struct $Name {
      pub message: String,
    }
    #[Object]
    impl $Name {
      async fn message(&self) -> &str {
        &self.message
      }
    }
  };
  // Pattern: `spaceId: String` only
  (space $Name:ident) => {
    pub struct $Name {
      pub space_id: String,
    }
    #[Object]
    impl $Name {
      #[graphql(name = "spaceId")]
      async fn space_id(&self) -> &str {
        &self.space_id
      }
    }
  };
  // Pattern: `docId + spaceId`
  (doc_space $Name:ident) => {
    pub struct $Name {
      pub doc_id: String,
      pub space_id: String,
    }
    #[Object]
    impl $Name {
      #[graphql(name = "docId")]
      async fn doc_id(&self) -> &str {
        &self.doc_id
      }
      #[graphql(name = "spaceId")]
      async fn space_id(&self) -> &str {
        &self.space_id
      }
    }
  };
}

error_data_type!(space AlreadyInSpaceDataType);

pub struct BlobNotFoundDataType {
  pub blob_id: String,
  pub space_id: String,
}
#[Object]
impl BlobNotFoundDataType {
  #[graphql(name = "blobId")]
  async fn blob_id(&self) -> &str {
    &self.blob_id
  }
  #[graphql(name = "spaceId")]
  async fn space_id(&self) -> &str {
    &self.space_id
  }
}

pub struct CalendarProviderRequestErrorDataType {
  pub message: String,
  pub status: i32,
}
#[Object]
impl CalendarProviderRequestErrorDataType {
  async fn message(&self) -> &str {
    &self.message
  }
  async fn status(&self) -> i32 {
    self.status
  }
}

pub struct CopilotContextFileNotSupportedDataType {
  pub file_name: String,
  pub message: String,
}
#[Object]
impl CopilotContextFileNotSupportedDataType {
  #[graphql(name = "fileName")]
  async fn file_name(&self) -> &str {
    &self.file_name
  }
  async fn message(&self) -> &str {
    &self.message
  }
}

pub struct CopilotDocNotFoundDataType {
  pub doc_id: String,
}
#[Object]
impl CopilotDocNotFoundDataType {
  #[graphql(name = "docId")]
  async fn doc_id(&self) -> &str {
    &self.doc_id
  }
}

error_data_type!(msg CopilotFailedToAddWorkspaceFileEmbeddingDataType);

pub struct CopilotFailedToGenerateEmbeddingDataType {
  pub message: String,
  pub provider: String,
}
#[Object]
impl CopilotFailedToGenerateEmbeddingDataType {
  async fn message(&self) -> &str {
    &self.message
  }
  async fn provider(&self) -> &str {
    &self.provider
  }
}

pub struct CopilotFailedToMatchContextDataType {
  pub content: String,
  pub context_id: String,
  pub message: String,
}
#[Object]
impl CopilotFailedToMatchContextDataType {
  async fn content(&self) -> &str {
    &self.content
  }
  #[graphql(name = "contextId")]
  async fn context_id(&self) -> &str {
    &self.context_id
  }
  async fn message(&self) -> &str {
    &self.message
  }
}

pub struct CopilotFailedToMatchGlobalContextDataType {
  pub content: String,
  pub message: String,
  pub workspace_id: String,
}
#[Object]
impl CopilotFailedToMatchGlobalContextDataType {
  async fn content(&self) -> &str {
    &self.content
  }
  async fn message(&self) -> &str {
    &self.message
  }
  #[graphql(name = "workspaceId")]
  async fn workspace_id(&self) -> &str {
    &self.workspace_id
  }
}

pub struct CopilotFailedToModifyContextDataType {
  pub context_id: String,
  pub message: String,
}
#[Object]
impl CopilotFailedToModifyContextDataType {
  #[graphql(name = "contextId")]
  async fn context_id(&self) -> &str {
    &self.context_id
  }
  async fn message(&self) -> &str {
    &self.message
  }
}

pub struct CopilotInvalidContextDataType {
  pub context_id: String,
}
#[Object]
impl CopilotInvalidContextDataType {
  #[graphql(name = "contextId")]
  async fn context_id(&self) -> &str {
    &self.context_id
  }
}

pub struct CopilotMessageNotFoundDataType {
  pub message_id: String,
}
#[Object]
impl CopilotMessageNotFoundDataType {
  #[graphql(name = "messageId")]
  async fn message_id(&self) -> &str {
    &self.message_id
  }
}

error_data_type!(msg CopilotPromptNotFoundDataType);
error_data_type!(msg CopilotProviderNotSupportedDataType);
error_data_type!(msg CopilotProviderSideErrorDataType);

error_data_type!(doc_space DocActionDeniedDataType);
error_data_type!(doc_space DocHistoryNotFoundDataType);
error_data_type!(doc_space DocNotFoundDataType);
error_data_type!(doc_space DocUpdateBlockedDataType);

error_data_type!(doc_space ExpectToGrantDocUserRolesDataType);
error_data_type!(doc_space ExpectToRevokeDocUserRolesDataType);
error_data_type!(doc_space ExpectToUpdateDocUserRoleDataType);

error_data_type!(msg HttpRequestErrorDataType);

pub struct InvalidAppConfigDataType {
  pub key: String,
  pub message: String,
}
#[Object]
impl InvalidAppConfigDataType {
  async fn key(&self) -> &str {
    &self.key
  }
  async fn message(&self) -> &str {
    &self.message
  }
}

pub struct InvalidAppConfigInputDataType {
  pub key: String,
  pub message: String,
}
#[Object]
impl InvalidAppConfigInputDataType {
  async fn key(&self) -> &str {
    &self.key
  }
  async fn message(&self) -> &str {
    &self.message
  }
}

error_data_type!(msg InvalidEmailDataType);
error_data_type!(msg InvalidHistoryTimestampDataType);
error_data_type!(msg InvalidIndexerInputDataType);
error_data_type!(msg InvalidLicenseToActivateDataType);
error_data_type!(msg InvalidLicenseUpdateParamsDataType);
error_data_type!(msg InvalidOauthCallbackCodeDataType);
error_data_type!(msg InvalidOauthResponseDataType);
error_data_type!(msg InvalidPasswordLengthDataType);
error_data_type!(msg InvalidRuntimeConfigTypeDataType);
error_data_type!(msg InvalidSearchProviderRequestDataType);

error_data_type!(space MemberNotFoundInSpaceDataType);
error_data_type!(msg MentionUserDocAccessDeniedDataType);
error_data_type!(msg MissingOauthQueryParameterDataType);
error_data_type!(msg NoCopilotProviderAvailableDataType);
error_data_type!(space NoMoreSeatDataType);
error_data_type!(space NotInSpaceDataType);
error_data_type!(msg QueryTooLongDataType);
error_data_type!(msg ResponseTooLargeErrorDataType);
error_data_type!(msg RuntimeConfigNotFoundDataType);
error_data_type!(msg SameSubscriptionRecurringDataType);
error_data_type!(space SpaceAccessDeniedDataType);
error_data_type!(space SpaceNotFoundDataType);
error_data_type!(space SpaceOwnerNotFoundDataType);
error_data_type!(space SpaceShouldHaveOnlyOneOwnerDataType);
error_data_type!(msg SsrfBlockedErrorDataType);
error_data_type!(msg SubscriptionAlreadyExistsDataType);
error_data_type!(msg SubscriptionNotExistsDataType);
error_data_type!(msg SubscriptionPlanNotFoundDataType);
error_data_type!(msg UnknownOauthProviderDataType);
error_data_type!(msg UnsupportedClientVersionDataType);
error_data_type!(msg UnsupportedSubscriptionPlanDataType);
error_data_type!(msg ValidationErrorDataType);
error_data_type!(msg VersionRejectedDataType);
error_data_type!(msg WorkspacePermissionNotFoundDataType);
error_data_type!(msg WrongSignInCredentialsDataType);

/// Union of all error data types — matches the upstream `ErrorDataUnion`.
#[derive(Union)]
pub enum ErrorDataUnion {
  AlreadyInSpace(AlreadyInSpaceDataType),
  BlobNotFound(BlobNotFoundDataType),
  CalendarProviderRequestError(CalendarProviderRequestErrorDataType),
  CopilotContextFileNotSupported(CopilotContextFileNotSupportedDataType),
  CopilotDocNotFound(CopilotDocNotFoundDataType),
  CopilotFailedToAddWorkspaceFileEmbedding(CopilotFailedToAddWorkspaceFileEmbeddingDataType),
  CopilotFailedToGenerateEmbedding(CopilotFailedToGenerateEmbeddingDataType),
  CopilotFailedToMatchContext(CopilotFailedToMatchContextDataType),
  CopilotFailedToMatchGlobalContext(CopilotFailedToMatchGlobalContextDataType),
  CopilotFailedToModifyContext(CopilotFailedToModifyContextDataType),
  CopilotInvalidContext(CopilotInvalidContextDataType),
  CopilotMessageNotFound(CopilotMessageNotFoundDataType),
  CopilotPromptNotFound(CopilotPromptNotFoundDataType),
  CopilotProviderNotSupported(CopilotProviderNotSupportedDataType),
  CopilotProviderSideError(CopilotProviderSideErrorDataType),
  DocActionDenied(DocActionDeniedDataType),
  DocHistoryNotFound(DocHistoryNotFoundDataType),
  DocNotFound(DocNotFoundDataType),
  DocUpdateBlocked(DocUpdateBlockedDataType),
  ExpectToGrantDocUserRoles(ExpectToGrantDocUserRolesDataType),
  ExpectToRevokeDocUserRoles(ExpectToRevokeDocUserRolesDataType),
  ExpectToUpdateDocUserRole(ExpectToUpdateDocUserRoleDataType),
  GraphqlBadRequest(GraphqlBadRequestDataType),
  HttpRequestError(HttpRequestErrorDataType),
  InvalidAppConfig(InvalidAppConfigDataType),
  InvalidAppConfigInput(InvalidAppConfigInputDataType),
  InvalidEmail(InvalidEmailDataType),
  InvalidHistoryTimestamp(InvalidHistoryTimestampDataType),
  InvalidIndexerInput(InvalidIndexerInputDataType),
  InvalidLicenseToActivate(InvalidLicenseToActivateDataType),
  InvalidLicenseUpdateParams(InvalidLicenseUpdateParamsDataType),
  InvalidOauthCallbackCode(InvalidOauthCallbackCodeDataType),
  InvalidOauthResponse(InvalidOauthResponseDataType),
  InvalidPasswordLength(InvalidPasswordLengthDataType),
  InvalidRuntimeConfigType(InvalidRuntimeConfigTypeDataType),
  InvalidSearchProviderRequest(InvalidSearchProviderRequestDataType),
  MemberNotFoundInSpace(MemberNotFoundInSpaceDataType),
  MentionUserDocAccessDenied(MentionUserDocAccessDeniedDataType),
  MissingOauthQueryParameter(MissingOauthQueryParameterDataType),
  NoCopilotProviderAvailable(NoCopilotProviderAvailableDataType),
  NoMoreSeat(NoMoreSeatDataType),
  NotInSpace(NotInSpaceDataType),
  QueryTooLong(QueryTooLongDataType),
  ResponseTooLargeError(ResponseTooLargeErrorDataType),
  RuntimeConfigNotFound(RuntimeConfigNotFoundDataType),
  SameSubscriptionRecurring(SameSubscriptionRecurringDataType),
  SpaceAccessDenied(SpaceAccessDeniedDataType),
  SpaceNotFound(SpaceNotFoundDataType),
  SpaceOwnerNotFound(SpaceOwnerNotFoundDataType),
  SpaceShouldHaveOnlyOneOwner(SpaceShouldHaveOnlyOneOwnerDataType),
  SsrfBlockedError(SsrfBlockedErrorDataType),
  SubscriptionAlreadyExists(SubscriptionAlreadyExistsDataType),
  SubscriptionNotExists(SubscriptionNotExistsDataType),
  SubscriptionPlanNotFound(SubscriptionPlanNotFoundDataType),
  UnknownOauthProvider(UnknownOauthProviderDataType),
  UnsupportedClientVersion(UnsupportedClientVersionDataType),
  UnsupportedSubscriptionPlan(UnsupportedSubscriptionPlanDataType),
  ValidationError(ValidationErrorDataType),
  VersionRejected(VersionRejectedDataType),
  WorkspacePermissionNotFound(WorkspacePermissionNotFoundDataType),
  WrongSignInCredentials(WrongSignInCredentialsDataType),
}

/// Resolve an `ErrorNames` value to a default `ErrorDataUnion` member with a
/// human-readable description.  This is a documentation/introspection query —
/// it returns static metadata, not runtime error state.
pub fn resolve_error(name: ErrorNames) -> ErrorDataUnion {
  // For most errors the `GraphqlBadRequestDataType` catch-all is fine; only
  // errors that have type-specific fields get a dedicated variant.
  let desc = error_description(name);
  ErrorDataUnion::GraphqlBadRequest(GraphqlBadRequestDataType {
    code: format!("{:?}", name),
    message: desc.to_string(),
  })
}

fn error_description(name: ErrorNames) -> &'static str {
  match name {
    ErrorNames::AccessDenied => "You do not have permission to access this resource.",
    ErrorNames::ActionForbidden => "The requested action is forbidden.",
    ErrorNames::AlreadyInSpace => "You are already a member of this space.",
    ErrorNames::AuthenticationRequired => "Authentication is required to perform this action.",
    ErrorNames::BadRequest => "The request was malformed or invalid.",
    ErrorNames::BlobInvalid => "The provided blob data is invalid.",
    ErrorNames::BlobNotFound => "The requested blob was not found.",
    ErrorNames::BlobQuotaExceeded => "Blob storage quota has been exceeded.",
    ErrorNames::CalendarProviderRequestError => "Calendar provider request failed.",
    ErrorNames::CannotDeleteAllAdminAccount => "Cannot delete the last admin account.",
    ErrorNames::CannotDeleteOwnAccount => "Cannot delete your own admin account via this endpoint.",
    ErrorNames::CantUpdateOnetimePaymentSubscription => "Cannot update a one-time payment subscription.",
    ErrorNames::CanNotBatchGrantDocOwnerPermissions => "Cannot batch-grant owner permissions on documents.",
    ErrorNames::CanNotRevokeYourself => "You cannot revoke your own access.",
    ErrorNames::CaptchaVerificationFailed => "Captcha verification failed.",
    ErrorNames::CommentAttachmentNotFound => "Comment attachment not found.",
    ErrorNames::CommentAttachmentQuotaExceeded => "Comment attachment quota exceeded.",
    ErrorNames::CommentNotFound => "The requested comment was not found.",
    ErrorNames::CopilotActionTaken => "Copilot action has already been taken.",
    ErrorNames::CopilotContextFileNotSupported => "The provided file type is not supported for copilot context.",
    ErrorNames::CopilotDocsNotFound => "Copilot documents not found.",
    ErrorNames::CopilotDocNotFound => "Copilot document not found.",
    ErrorNames::CopilotEmbeddingDisabled => "Copilot embedding is disabled.",
    ErrorNames::CopilotEmbeddingUnavailable => "Copilot embedding service is unavailable.",
    ErrorNames::CopilotFailedToAddWorkspaceFileEmbedding => "Failed to add workspace file embedding.",
    ErrorNames::CopilotFailedToCreateMessage => "Failed to create copilot message.",
    ErrorNames::CopilotFailedToGenerateEmbedding => "Failed to generate embedding.",
    ErrorNames::CopilotFailedToGenerateText => "Failed to generate text.",
    ErrorNames::CopilotFailedToMatchContext => "Failed to match copilot context.",
    ErrorNames::CopilotFailedToMatchGlobalContext => "Failed to match global copilot context.",
    ErrorNames::CopilotFailedToModifyContext => "Failed to modify copilot context.",
    ErrorNames::CopilotInvalidContext => "Invalid copilot context.",
    ErrorNames::CopilotMessageNotFound => "Copilot message not found.",
    ErrorNames::CopilotPromptInvalid => "Copilot prompt is invalid.",
    ErrorNames::CopilotPromptNotFound => "Copilot prompt not found.",
    ErrorNames::CopilotProviderNotSupported => "Copilot provider is not supported.",
    ErrorNames::CopilotProviderSideError => "Copilot provider returned an error.",
    ErrorNames::CopilotQuotaExceeded => "Copilot usage quota has been exceeded.",
    ErrorNames::CopilotSessionDeleted => "Copilot session has been deleted.",
    ErrorNames::CopilotSessionInvalidInput => "Invalid input for copilot session.",
    ErrorNames::CopilotSessionNotFound => "Copilot session not found.",
    ErrorNames::CopilotTranscriptionAudioNotProvided => "Audio not provided for transcription.",
    ErrorNames::CopilotTranscriptionJobExists => "Transcription job already exists.",
    ErrorNames::CopilotTranscriptionJobNotFound => "Transcription job not found.",
    ErrorNames::CustomerPortalCreateFailed => "Failed to create customer portal.",
    ErrorNames::DocActionDenied => "The requested document action is denied.",
    ErrorNames::DocDefaultRoleCanNotBeOwner => "Default document role cannot be owner.",
    ErrorNames::DocHistoryNotFound => "Document history not found.",
    ErrorNames::DocIsNotPublic => "The document is not public.",
    ErrorNames::DocNotFound => "Document not found.",
    ErrorNames::DocUpdateBlocked => "Document update is blocked.",
    ErrorNames::EmailAlreadyUsed => "This email address is already in use.",
    ErrorNames::EmailServiceNotConfigured => "Email service is not configured.",
    ErrorNames::EmailTokenNotFound => "Email verification token not found.",
    ErrorNames::EmailVerificationRequired => "Email verification is required.",
    ErrorNames::ExpectToGrantDocUserRoles => "Expected to grant document user roles.",
    ErrorNames::ExpectToPublishDoc => "Expected to publish the document.",
    ErrorNames::ExpectToRevokeDocUserRoles => "Expected to revoke document user roles.",
    ErrorNames::ExpectToRevokePublicDoc => "Expected to revoke public document access.",
    ErrorNames::ExpectToUpdateDocUserRole => "Expected to update document user role.",
    ErrorNames::FailedToCheckout => "Checkout process failed.",
    ErrorNames::FailedToSaveUpdates => "Failed to save updates.",
    ErrorNames::FailedToUpsertSnapshot => "Failed to save document snapshot.",
    ErrorNames::GraphqlBadRequest => "The GraphQL request was malformed.",
    ErrorNames::HttpRequestError => "An HTTP request error occurred.",
    ErrorNames::InternalServerError => "An internal server error occurred.",
    ErrorNames::InvalidAppConfig => "Invalid application configuration.",
    ErrorNames::InvalidAppConfigInput => "Invalid application configuration input.",
    ErrorNames::InvalidAuthState => "Invalid authentication state.",
    ErrorNames::InvalidCheckoutParameters => "Invalid checkout parameters.",
    ErrorNames::InvalidEmail => "The provided email address is invalid.",
    ErrorNames::InvalidEmailToken => "The email token is invalid.",
    ErrorNames::InvalidHistoryTimestamp => "Invalid history timestamp.",
    ErrorNames::InvalidIndexerInput => "Invalid indexer input.",
    ErrorNames::InvalidInvitation => "The invitation is invalid.",
    ErrorNames::InvalidLicenseSessionId => "Invalid license session ID.",
    ErrorNames::InvalidLicenseToActivate => "The license cannot be activated.",
    ErrorNames::InvalidLicenseUpdateParams => "Invalid license update parameters.",
    ErrorNames::InvalidOauthCallbackCode => "Invalid OAuth callback code.",
    ErrorNames::InvalidOauthCallbackState => "Invalid OAuth callback state.",
    ErrorNames::InvalidOauthResponse => "Invalid OAuth response.",
    ErrorNames::InvalidPasswordLength => "Password does not meet length requirements.",
    ErrorNames::InvalidRuntimeConfigType => "Invalid runtime configuration type.",
    ErrorNames::InvalidSearchProviderRequest => "Invalid search provider request.",
    ErrorNames::InvalidSubscriptionParameters => "Invalid subscription parameters.",
    ErrorNames::LicenseExpired => "The license has expired.",
    ErrorNames::LicenseNotFound => "License not found.",
    ErrorNames::LicenseRevealed => "License key has already been revealed.",
    ErrorNames::LinkExpired => "The link has expired.",
    ErrorNames::MailerServiceIsNotConfigured => "Mailer service is not configured.",
    ErrorNames::ManagedByAppStoreOrPlay => "Subscription is managed by App Store or Google Play.",
    ErrorNames::MemberNotFoundInSpace => "Member not found in the space.",
    ErrorNames::MemberQuotaExceeded => "Member quota has been exceeded.",
    ErrorNames::MentionUserDocAccessDenied => "The mentioned user does not have access to this document.",
    ErrorNames::MentionUserOneselfDenied => "You cannot mention yourself.",
    ErrorNames::MissingOauthQueryParameter => "Missing OAuth query parameter.",
    ErrorNames::NetworkError => "A network error occurred.",
    ErrorNames::NewOwnerIsNotActiveMember => "The new owner must be an active member.",
    ErrorNames::NotificationNotFound => "Notification not found.",
    ErrorNames::NotFound => "The requested resource was not found.",
    ErrorNames::NotInSpace => "You are not a member of this space.",
    ErrorNames::NoCopilotProviderAvailable => "No copilot provider is available.",
    ErrorNames::NoMoreSeat => "No more seats available in this space.",
    ErrorNames::OauthAccountAlreadyConnected => "This OAuth account is already connected.",
    ErrorNames::OauthStateExpired => "OAuth state has expired.",
    ErrorNames::OwnerCanNotLeaveWorkspace => "The workspace owner cannot leave the workspace.",
    ErrorNames::PasswordRequired => "A password is required.",
    ErrorNames::QueryTooLong => "The search query is too long.",
    ErrorNames::ReplyNotFound => "Reply not found.",
    ErrorNames::ResponseTooLargeError => "The response is too large.",
    ErrorNames::RuntimeConfigNotFound => "Runtime configuration not found.",
    ErrorNames::SameEmailProvided => "The same email address was provided.",
    ErrorNames::SameSubscriptionRecurring => "Already on the same subscription recurring plan.",
    ErrorNames::SearchProviderNotFound => "Search provider not found.",
    ErrorNames::SignUpForbidden => "Sign-up is currently forbidden.",
    ErrorNames::SpaceAccessDenied => "Access to this space is denied.",
    ErrorNames::SpaceNotFound => "Space not found.",
    ErrorNames::SpaceOwnerNotFound => "Space owner not found.",
    ErrorNames::SpaceShouldHaveOnlyOneOwner => "A space should have only one owner.",
    ErrorNames::SsrfBlockedError => "The request was blocked for security reasons (SSRF).",
    ErrorNames::StorageQuotaExceeded => "Storage quota has been exceeded.",
    ErrorNames::SubscriptionAlreadyExists => "A subscription already exists.",
    ErrorNames::SubscriptionExpired => "The subscription has expired.",
    ErrorNames::SubscriptionHasBeenCanceled => "The subscription has been canceled.",
    ErrorNames::SubscriptionHasNotBeenCanceled => "The subscription has not been canceled.",
    ErrorNames::SubscriptionNotExists => "No subscription exists.",
    ErrorNames::SubscriptionPlanNotFound => "Subscription plan not found.",
    ErrorNames::TooManyRequest => "Too many requests. Please try again later.",
    ErrorNames::UnknownOauthProvider => "Unknown OAuth provider.",
    ErrorNames::UnsplashIsNotConfigured => "Unsplash integration is not configured.",
    ErrorNames::UnsupportedClientVersion => "This client version is not supported.",
    ErrorNames::UnsupportedSubscriptionPlan => "This subscription plan is not supported.",
    ErrorNames::UserAvatarNotFound => "User avatar not found.",
    ErrorNames::UserNotFound => "User not found.",
    ErrorNames::ValidationError => "Validation failed.",
    ErrorNames::VersionRejected => "This version has been rejected.",
    ErrorNames::WorkspaceIdRequiredForTeamSubscription => "Workspace ID is required for team subscriptions.",
    ErrorNames::WorkspaceIdRequiredToUpdateTeamSubscription => "Workspace ID is required to update team subscriptions.",
    ErrorNames::WorkspaceLicenseAlreadyExists => "A workspace license already exists.",
    ErrorNames::WorkspacePermissionNotFound => "Workspace permission not found.",
    ErrorNames::WrongSignInCredentials => "Wrong sign-in credentials.",
    ErrorNames::WrongSignInMethod => "Wrong sign-in method.",
  }
}
