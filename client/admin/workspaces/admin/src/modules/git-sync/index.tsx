/**
 * Git Sync administration page.
 *
 * Provides a dedicated top-level admin page for managing Git Sync policy,
 * operations configuration, storage monitoring, and workspace sync profiles.
 *
 * Uses the same `useAppConfig` hook and `config form field` components as the Settings
 * page to manage `gitSync` config. The page intentionally keeps the existing
 * admin config APIs; the skin must not introduce a separate API root.
 */
import { useI18n } from "@myoxus/i18n";
import { Stack, StatusDot, Tabs, TabsContent } from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";

import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { useRevalidateServerConfig } from "../common";
import { type AppConfig } from "../settings/config";
import type { AdminConfigSchemaSnapshot } from "../settings/use-admin-config-contract";
import type { AdminConfigFieldState } from "../settings/use-admin-config-contract";
import { useAppConfig } from "../settings/use-app-config";
import { ActivityTab } from "./activity-tab";
import { createGitSyncDiagnosis, reportGitSyncDiagnosis } from "./diagnostics";
import {
  GitSyncRecoveryNotice,
  GitSyncTabErrorBoundary,
} from "./git-sync-recovery";
import { OperationsTab } from "./operations-tab";
import { PolicyTab } from "./policy-tab";
import { ProfilesTab } from "./profiles-tab";
import { StorageTab } from "./storage-tab";

// ---------------------------------------------------------------------------
// Shared Props Interface
// ---------------------------------------------------------------------------

/**
 * Props shared by all config-based tab components (Policy, Operations, Storage).
 * ProfilesTab is standalone and does not use these props.
 */
export interface GitSyncTabProps {
  appConfig: AppConfig;
  patchedAppConfig: AppConfig;
  schema?: AdminConfigSchemaSnapshot | null;
  onUpdate: (path: string, value: any) => void;
  onSaveGroup: (module: string) => Promise<void>;
  onResetGroup: (module: string) => void;
  isGroupDirty: (module: string) => boolean;
  isGroupSaving: (module: string) => boolean;
  getGroupVersion: (module: string) => number;
  fieldErrorsByPath: Record<string, { message: string }>;
  configFieldStates?: Record<string, AdminConfigFieldState>;
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const TAB_IDS = [
  "policy",
  "activity",
  "operations",
  "storage",
  "profiles",
] as const;

const TAB_LABEL_KEYS = {
  policy: "admin.git-sync.tab.policy",
  activity: "admin.git-sync.tab.activity",
  operations: "admin.git-sync.tab.operations",
  storage: "admin.git-sync.tab.storage",
  profiles: "admin.git-sync.tab.profiles",
} as const;

export function GitSyncPage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(TAB_IDS, "policy");
  const {
    appConfig,
    update,
    saveGroup,
    resetGroup,
    patchedAppConfig,
    schema,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
    normalizationIssues = [],
    configFieldStates = {},
    schemaError,
    valuesError,
    isLoading,
    schemaRevision,
    configRevision,
    reloadServerState,
    discardLocalChanges,
  } = useAppConfig();
  const revalidateServerConfig = useRevalidateServerConfig();
  const actionableNormalizationIssues =
    isLoading || schemaError || valuesError ? [] : normalizationIssues;

  const handleSaveGroup = useCallback(
    async (module: string) => {
      await saveGroup(module);
      await revalidateServerConfig();
    },
    [saveGroup, revalidateServerConfig],
  );
  const gitSyncIssueDiagnoses = useMemo(
    () =>
      actionableNormalizationIssues
        .filter(
          (issue) =>
            issue.path === "git_sync" || issue.path.startsWith("git_sync."),
        )
        .map((issue) =>
          createGitSyncDiagnosis({
            code: issue.code,
            tab: activeTab,
            fieldPath: issue.path,
            expectedType: issue.expectedType,
            actualType: issue.actualType,
            schemaRevision,
            configRevision,
          }),
        ),
    [actionableNormalizationIssues, activeTab, configRevision, schemaRevision],
  );

  useEffect(() => {
    for (const diagnosis of gitSyncIssueDiagnoses) {
      reportGitSyncDiagnosis(diagnosis);
    }
  }, [gitSyncIssueDiagnoses]);

  const configProps: GitSyncTabProps = {
    appConfig,
    patchedAppConfig,
    schema,
    onUpdate: update,
    onSaveGroup: handleSaveGroup,
    onResetGroup: resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath: {
      ...fieldErrorsByPath,
      ...Object.fromEntries(
        gitSyncIssueDiagnoses
          .filter((diagnosis) => diagnosis.code !== "UNKNOWN_FIELD")
          .map((diagnosis) => [
            diagnosis.fieldPath!.replace(/\./g, "/"),
            {
              message: i18n.t("admin.git-sync.recovery.field-type", {
                expectedType: diagnosis.expectedType!,
                actualType: diagnosis.actualType!,
                diagnosisId: diagnosis.id,
              }),
            },
          ]),
      ),
    },
    configFieldStates,
  };
  const configQueryFailed = Boolean(schemaError || valuesError);
  const gitSyncIssue = actionableNormalizationIssues.find(
    (issue) => issue.path === "git_sync" || issue.path.startsWith("git_sync."),
  );
  const configDiagnosis = useMemo(
    () =>
      configQueryFailed
        ? createGitSyncDiagnosis({
            code: "CONFIG_QUERY",
            tab: activeTab,
            operationName: schemaError
              ? "adminConfigSchema"
              : "adminConfigValues",
            schemaRevision,
            configRevision,
          })
        : (gitSyncIssueDiagnoses[0] ??
          createGitSyncDiagnosis({
            code: "CONFIG_STATE",
            tab: activeTab,
            schemaRevision,
            configRevision,
          })),
    [
      activeTab,
      configQueryFailed,
      configRevision,
      gitSyncIssueDiagnoses,
      schemaError,
      schemaRevision,
    ],
  );

  const withBoundary = useCallback(
    (tab: (typeof TAB_IDS)[number], content: ReactNode) => (
      <GitSyncTabErrorBoundary
        tab={tab}
        onReload={reloadServerState}
        onDiscard={discardLocalChanges}
      >
        {content}
      </GitSyncTabErrorBoundary>
    ),
    [discardLocalChanges, reloadServerState],
  );

  return (
    <AdminPageFrame
      title={i18n.t("admin.git-sync.title")}
      routeAnchor="admin-route-git-sync"
      actions={
        <StatusDot
          tone={configQueryFailed ? "error" : isLoading ? "warning" : "success"}
          label={
            configQueryFailed
              ? i18n.t("admin.git-sync.recovery.title")
              : isLoading
                ? i18n.t("admin.common.loading")
                : i18n.t("admin.state.active")
          }
        />
      }
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={TAB_IDS.map((value) => ({
            value,
            label: i18n.t(TAB_LABEL_KEYS[value]),
          }))}
        />
        <AdminPageScroll>
          <Stack>
            {configQueryFailed || gitSyncIssue ? (
              <GitSyncRecoveryNotice
                diagnosis={configDiagnosis}
                onReload={reloadServerState}
                onDiscard={discardLocalChanges}
              />
            ) : null}

            <TabsContent value="policy" layout="stack">
              {withBoundary("policy", <PolicyTab {...configProps} />)}
            </TabsContent>

            <TabsContent value="activity" layout="stack">
              {withBoundary("activity", <ActivityTab />)}
            </TabsContent>

            <TabsContent value="operations" layout="stack">
              {withBoundary("operations", <OperationsTab {...configProps} />)}
            </TabsContent>

            <TabsContent value="storage" layout="stack">
              {withBoundary("storage", <StorageTab {...configProps} />)}
            </TabsContent>

            <TabsContent value="profiles" layout="stack">
              {withBoundary("profiles", <ProfilesTab />)}
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}

export { GitSyncPage as Component };
