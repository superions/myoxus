// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  GitSyncAuthMethod,
  GitSyncCronMisfirePolicy,
  GitSyncDirection,
  GitSyncRunSource,
  GitSyncTriggerMode,
} from "@myoxus/graphql";

export const GIT_SYNC_TRIGGER_LABELS = {
  [GitSyncTriggerMode.Manual]: "com.myoxus.integration.git-sync.trigger.manual",
  [GitSyncTriggerMode.Polling]:
    "com.myoxus.integration.git-sync.trigger.polling",
  [GitSyncTriggerMode.Webhook]:
    "com.myoxus.integration.git-sync.trigger.webhook",
  [GitSyncTriggerMode.Cron]: "com.myoxus.integration.git-sync.trigger.cron",
  [GitSyncTriggerMode.HistoryCapture]:
    "com.myoxus.integration.git-sync.trigger.history-capture",
} as const;

export const GIT_SYNC_RUN_SOURCE_LABELS = {
  [GitSyncRunSource.Manual]: "com.myoxus.integration.git-sync.trigger.manual",
  [GitSyncRunSource.Polling]: "com.myoxus.integration.git-sync.trigger.polling",
  [GitSyncRunSource.Webhook]: "com.myoxus.integration.git-sync.trigger.webhook",
  [GitSyncRunSource.Cron]: "com.myoxus.integration.git-sync.trigger.cron",
  [GitSyncRunSource.HistoryCapture]:
    "com.myoxus.integration.git-sync.trigger.history-capture",
} as const;

export const GIT_SYNC_DIRECTION_LABELS = {
  [GitSyncDirection.Bidirectional]:
    "com.myoxus.integration.git-sync.direction.bidirectional",
  [GitSyncDirection.MyoxusToGit]:
    "com.myoxus.integration.git-sync.direction.push",
  [GitSyncDirection.GitToMyoxus]:
    "com.myoxus.integration.git-sync.direction.pull",
} as const;

export const GIT_SYNC_AUTH_LABELS = {
  [GitSyncAuthMethod.HttpsToken]: "com.myoxus.integration.git-sync.auth.token",
  [GitSyncAuthMethod.HttpsPassword]:
    "com.myoxus.integration.git-sync.auth.https-password",
  [GitSyncAuthMethod.SshKey]: "com.myoxus.integration.git-sync.auth.ssh-key",
} as const;

export const GIT_SYNC_MISFIRE_LABELS = {
  [GitSyncCronMisfirePolicy.Skip]:
    "com.myoxus.integration.git-sync.misfire.skip",
  [GitSyncCronMisfirePolicy.RunOnce]:
    "com.myoxus.integration.git-sync.misfire.run-once",
} as const;

export function isGitSyncTriggerMode(
  value: string,
): value is GitSyncTriggerMode {
  return Object.values(GitSyncTriggerMode).some(
    (candidate) => candidate === value,
  );
}
