//! Regression test: Git Sync GraphQL enums must serialize as PascalCase
//! to match the TypeScript frontend expectations.
//!
//! P30-09: async-graphql default SCREAMING_SNAKE_CASE caused "does not
//! contain the value" errors when the frontend sent PascalCase values.

use async_graphql::EnumType;

/// Helper: get the GraphQL name of an enum variant.
fn enum_name<T: EnumType>(variant: T) -> &'static str {
  T::items()
    .iter()
    .find(|item| item.value == variant)
    .expect("variant not found in items")
    .name
}

#[test]
fn git_sync_direction_uses_pascal_case() {
  use myoxus_api::graphql::git_sync::GitSyncDirectionType;

  assert_eq!(enum_name(GitSyncDirectionType::Bidirectional), "Bidirectional");
  assert_eq!(enum_name(GitSyncDirectionType::MyoxusToGit), "MyoxusToGit");
  assert_eq!(enum_name(GitSyncDirectionType::GitToMyoxus), "GitToMyoxus");
}

#[test]
fn git_sync_auth_method_uses_pascal_case() {
  use myoxus_api::graphql::git_sync::GitSyncAuthMethodType;

  assert_eq!(enum_name(GitSyncAuthMethodType::HttpsToken), "HttpsToken");
  assert_eq!(enum_name(GitSyncAuthMethodType::HttpsPassword), "HttpsPassword");
  assert_eq!(enum_name(GitSyncAuthMethodType::SshKey), "SshKey");
}

#[test]
fn git_sync_trigger_mode_uses_pascal_case() {
  use myoxus_api::graphql::git_sync::GitSyncTriggerModeType;

  assert_eq!(enum_name(GitSyncTriggerModeType::Manual), "Manual");
  assert_eq!(enum_name(GitSyncTriggerModeType::Polling), "Polling");
  assert_eq!(enum_name(GitSyncTriggerModeType::Webhook), "Webhook");
}

#[test]
fn git_sync_run_status_uses_pascal_case() {
  use myoxus_api::graphql::git_sync::GitSyncRunStatusType;

  assert_eq!(enum_name(GitSyncRunStatusType::Pending), "Pending");
  assert_eq!(enum_name(GitSyncRunStatusType::Running), "Running");
  assert_eq!(enum_name(GitSyncRunStatusType::Completed), "Completed");
  assert_eq!(enum_name(GitSyncRunStatusType::Failed), "Failed");
  assert_eq!(enum_name(GitSyncRunStatusType::Cancelled), "Cancelled");
}

#[test]
fn git_sync_conflict_kind_uses_pascal_case() {
  use myoxus_api::graphql::git_sync::GitSyncConflictTypeEnum;

  assert_eq!(enum_name(GitSyncConflictTypeEnum::BothModified), "BothModified");
  assert_eq!(enum_name(GitSyncConflictTypeEnum::DeleteVsModify), "DeleteVsModify");
  assert_eq!(enum_name(GitSyncConflictTypeEnum::ModifyVsDelete), "ModifyVsDelete");
  assert_eq!(enum_name(GitSyncConflictTypeEnum::RenameVsRename), "RenameVsRename");
  assert_eq!(enum_name(GitSyncConflictTypeEnum::RenameVsModify), "RenameVsModify");
}

#[test]
fn git_sync_conflict_resolution_uses_pascal_case() {
  use myoxus_api::graphql::git_sync::GitSyncConflictResolutionType;

  assert_eq!(enum_name(GitSyncConflictResolutionType::MyoxusWins), "MyoxusWins");
  assert_eq!(enum_name(GitSyncConflictResolutionType::GitWins), "GitWins");
  assert_eq!(enum_name(GitSyncConflictResolutionType::ManualMerge), "ManualMerge");
  assert_eq!(enum_name(GitSyncConflictResolutionType::Dismissed), "Dismissed");
}

#[test]
fn admin_workspace_sort_uses_pascal_case() {
  use myoxus_api::graphql::AdminWorkspaceSort;

  assert_eq!(enum_name(AdminWorkspaceSort::CreatedAt), "CreatedAt");
  assert_eq!(enum_name(AdminWorkspaceSort::MemberCount), "MemberCount");
  assert_eq!(enum_name(AdminWorkspaceSort::BlobSize), "BlobSize");
  assert_eq!(enum_name(AdminWorkspaceSort::SnapshotCount), "SnapshotCount");
}

/// P30-09c: All frontend-facing enums must use PascalCase serialization.
#[test]
fn oauth_provider_uses_pascal_case() {
  use myoxus_api::graphql::auth::types::OAuthProviderType;
  assert_eq!(enum_name(OAuthProviderType::Google), "Google");
  assert_eq!(enum_name(OAuthProviderType::GitHub), "GitHub");
  assert_eq!(enum_name(OAuthProviderType::Apple), "Apple");
}

#[test]
fn server_feature_uses_pascal_case() {
  use myoxus_api::graphql::auth::types::ServerFeature;
  assert_eq!(enum_name(ServerFeature::OAuth), "OAuth");
  assert_eq!(enum_name(ServerFeature::Copilot), "Copilot");
}

#[test]
fn workspace_member_status_uses_pascal_case() {
  use myoxus_api::graphql::auth::types::WorkspaceMemberStatus;
  assert_eq!(enum_name(WorkspaceMemberStatus::Pending), "Pending");
  assert_eq!(enum_name(WorkspaceMemberStatus::Accepted), "Accepted");
}

#[test]
fn search_query_occur_uses_lowercase() {
  use myoxus_api::graphql::auth::types::SearchQueryOccurType;
  assert_eq!(enum_name(SearchQueryOccurType::Must), "must");
  assert_eq!(enum_name(SearchQueryOccurType::MustNot), "must_not");
  assert_eq!(enum_name(SearchQueryOccurType::Should), "should");
}
