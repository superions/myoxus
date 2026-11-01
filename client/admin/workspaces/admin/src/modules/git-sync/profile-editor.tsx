// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Central Admin authoring for one workspace Git Sync profile.
 *
 * Cron parsing, timezone validity and occurrence calculation remain
 * server-owned. The form only submits generated GraphQL enums and displays the
 * five concrete occurrences returned by the schedule-preview query.
 */
import {
  adminGitTokenRotationQuery,
  configureGitTokenRotationMutation,
  createGitSyncProfileMutation,
  getGitSyncPoliciesQuery,
  getGitSyncProfileQuery,
  getGitSyncStatusQuery,
  GitSyncAuthMethod,
  GitSyncCronMisfirePolicy,
  GitSyncDirection,
  gitSyncSchedulePreviewQuery,
  gitSyncTimezonesQuery,
  GitSyncTriggerMode,
  GitTokenRotationProvider,
  GitTokenRotationState,
  runGitTokenRotationNowMutation,
  testGitConnectionMutation,
  triggerGitSyncMutation,
  updateGitSyncProfileMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormRow,
  FormFieldset,
  FormSelect,
  Input,
  Group,
  NumberInput,
  notify,
  PasswordInput,
  SettingsControlList,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsEmptyState,
  SettingsNotice,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsStatusText,
  SettingsSwitchRow,
  SettingsToolbar,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { formatAdminDateTime } from "../../utils/locale-format";
import {
  GIT_SYNC_AUTH_LABELS,
  GIT_SYNC_DIRECTION_LABELS,
  GIT_SYNC_MISFIRE_LABELS,
  GIT_SYNC_RUN_SOURCE_LABELS,
  GIT_SYNC_TRIGGER_LABELS,
} from "./git-sync-labels";

interface Profile {
  id: string;
  repoUrl: string;
  branch: string;
  rootPath: string;
  syncDirection: GitSyncDirection;
  triggerMode: GitSyncTriggerMode;
  pollingIntervalSecs: number | null;
  cronExpression: string | null;
  cronTimezone: string | null;
  cronMisfirePolicy: GitSyncCronMisfirePolicy | null;
  cronNextScheduledAt: string | null;
  cronPendingMisfireScheduledFor: string | null;
  authMethod: GitSyncAuthMethod;
  enabled: boolean;
  updatedAt: string;
}

interface ScheduleOccurrence {
  scheduledAtUtc: string;
  localDateTime: string;
  utcOffsetSeconds: number;
}

interface TokenRotationStatus {
  profileId: string;
  provider: GitTokenRotationProvider;
  enabled: boolean;
  state: GitTokenRotationState;
  renewBeforeDays: number;
  requestedLifetimeDays: number;
  currentCredentialExpiresAt: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  diagnosis: string | null;
}

const TOKEN_ROTATION_STATE_LABELS = {
  [GitTokenRotationState.Configured]:
    "admin.git-sync.rotation.state.configured",
  [GitTokenRotationState.Rotating]: "admin.git-sync.rotation.state.rotating",
  [GitTokenRotationState.Completed]: "admin.git-sync.rotation.state.completed",
  [GitTokenRotationState.Failed]: "admin.git-sync.rotation.state.failed",
  [GitTokenRotationState.ManualIntervention]:
    "admin.git-sync.rotation.state.manual-intervention",
} as const;

type ProfileField = "cronExpression" | "cronTimezone" | "pollingIntervalSecs";

export function formatScheduleOccurrence(
  language: string | undefined,
  occurrence: ScheduleOccurrence,
): string {
  const sign = occurrence.utcOffsetSeconds < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(occurrence.utcOffsetSeconds);
  const offsetHours = String(Math.floor(absoluteOffset / 3600)).padStart(
    2,
    "0",
  );
  const offsetMinutes = String(
    Math.floor((absoluteOffset % 3600) / 60),
  ).padStart(2, "0");
  const local = occurrence.localDateTime.replace("T", " ");
  const utc = formatAdminDateTime(language, occurrence.scheduledAtUtc);
  return `${local} (UTC${sign}${offsetHours}:${offsetMinutes}) · ${utc}`;
}

function isValidRepoUrl(value: string) {
  const trimmed = value.trim();
  if (/^git@[^:/\s]+:[^\s]+$/.test(trimmed)) return true;
  try {
    const url = new URL(trimmed);
    return (
      ["http:", "https:", "ssh:"].includes(url.protocol) &&
      url.hostname.length > 0 &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

function isValidBranch(value: string) {
  return (
    value.trim().length > 0 &&
    /^[a-zA-Z0-9_\-/.]+$/.test(value.trim()) &&
    !value.trim().startsWith("-")
  );
}

function serverErrorField(error: unknown): ProfileField | null {
  const extensions = (error as { extensions?: Record<string, unknown> })
    ?.extensions;
  const field = extensions?.field;
  return field === "cronExpression" ||
    field === "cronTimezone" ||
    field === "pollingIntervalSecs"
    ? field
    : null;
}

function serverErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : fallback;
}

function profileDate(
  language: string | undefined,
  value: string | null | undefined,
  fallback: string,
) {
  return value ? formatAdminDateTime(language, value) : fallback;
}

interface EditorLifecycle {
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

function TokenRotationEditor({
  profileId,
  onDirtyChange,
  onBusyChange,
}: { profileId: string } & EditorLifecycle) {
  const i18n = useI18n();
  const query = useQuery({
    query: adminGitTokenRotationQuery,
    variables: { profileId },
  });
  const { trigger: configure, isMutating: isConfiguring } = useMutation({
    mutation: configureGitTokenRotationMutation,
  });
  const { trigger: runNow, isMutating: isRunning } = useMutation({
    mutation: runGitTokenRotationNowMutation,
  });
  const status = (query.data?.admin?.gitTokenRotationStatus ??
    null) as TokenRotationStatus | null;
  const providers = query.data?.admin?.gitTokenRotationProviders ?? [];
  const [provider, setProvider] = useState<GitTokenRotationProvider>(
    GitTokenRotationProvider.GitLab,
  );
  const [enabled, setEnabled] = useState(false);
  const [renewBeforeDays, setRenewBeforeDays] = useState("30");
  const [requestedLifetimeDays, setRequestedLifetimeDays] = useState("90");
  const [actionBusy, setActionBusy] = useState(false);
  const busy = actionBusy || isConfiguring || isRunning;
  const [baseline, setBaseline] = useState(
    JSON.stringify([GitTokenRotationProvider.GitLab, false, "30", "90"]),
  );
  const lastAdoptedServerValue = useRef<string | null>(null);
  const snapshot = JSON.stringify([
    provider,
    enabled,
    renewBeforeDays,
    requestedLifetimeDays,
  ]);
  const dirty = baseline !== snapshot;

  // Native Tabs replay effects on reactivation. Only pristine fields may adopt
  // new server values; status refreshes must never overwrite an operator draft.
  useEffect(() => {
    if (!status || dirty) return;
    const next = JSON.stringify([
      status.provider,
      status.enabled,
      String(status.renewBeforeDays),
      String(status.requestedLifetimeDays),
    ]);
    if (next === lastAdoptedServerValue.current) return;
    lastAdoptedServerValue.current = next;
    setProvider(status.provider);
    setEnabled(status.enabled);
    setRenewBeforeDays(String(status.renewBeforeDays));
    setRequestedLifetimeDays(String(status.requestedLifetimeDays));
    setBaseline(next);
  }, [status, dirty, baseline]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const renewDays = Number(renewBeforeDays);
  const lifetimeDays = Number(requestedLifetimeDays);
  const configurationIsValid =
    Number.isInteger(renewDays) &&
    renewDays >= 1 &&
    renewDays <= 365 &&
    Number.isInteger(lifetimeDays) &&
    lifetimeDays >= 1 &&
    lifetimeDays <= 365 &&
    renewDays < lifetimeDays &&
    providers.includes(provider);
  const notAvailable = i18n.t("admin.git-sync.rotation.not-available");
  const stateLabel = status ? TOKEN_ROTATION_STATE_LABELS[status.state] : null;

  async function saveRotation() {
    if (!configurationIsValid || busy) return;
    setActionBusy(true);
    try {
      await configure({
        input: {
          profileId,
          provider,
          enabled,
          renewBeforeDays: renewDays,
          requestedLifetimeDays: lifetimeDays,
        },
      });
      await query.mutate();
      setBaseline(snapshot);
      notify.success({
        title: i18n.t("admin.git-sync.rotation.settings-updated"),
      });
    } catch {
      notify.error({ title: i18n.t("admin.git-sync.recovery.title") });
    } finally {
      setActionBusy(false);
    }
  }

  async function rotateNow() {
    if (busy || dirty) return;
    setActionBusy(true);
    let failed = false;
    try {
      try {
        await runNow({ profileId });
      } catch {
        failed = true;
      }
      // Failed rotation can still change server diagnosis/manual-intervention
      // state. Read it back without turning either failure into success.
      try {
        await query.mutate();
      } catch {
        failed = true;
      }
      if (failed)
        notify.error({ title: i18n.t("admin.git-sync.recovery.title") });
      else
        notify.success({ title: i18n.t("admin.git-sync.rotation.completed") });
    } finally {
      setActionBusy(false);
    }
  }

  if (query.isLoading && !query.data) {
    return <SettingsEmptyState title={i18n.t("admin.common.loading")} />;
  }
  if (query.error && !query.data) {
    return (
      <SettingsNotice tone="error">
        {i18n.t("admin.git-sync.recovery.title")}
      </SettingsNotice>
    );
  }

  return (
    <Stack>
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.git-sync.rotation.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.git-sync.rotation.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {query.error ? (
        <SettingsNotice tone="error">
          {i18n.t("admin.git-sync.recovery.title")}
        </SettingsNotice>
      ) : null}
      <FormFieldset disabled={busy} variant="unstyled">
        <SettingsControlList>
          <FormSelect
            label={i18n.t("admin.git-sync.rotation.provider")}
            value={provider}
            data={providers.map((value) => ({ value, label: value }))}
            onChange={(value) => setProvider(value as GitTokenRotationProvider)}
            disabled={providers.length === 0}
          />
          <SettingsSwitchRow
            label={i18n.t("admin.git-sync.rotation.enabled")}
            checked={enabled}
            onChange={setEnabled}
            description={i18n.t("admin.git-sync.rotation.enabled.description")}
          />
          <FormRow
            label={i18n.t("admin.git-sync.rotation.renew-before-days")}
            labelFor="git-token-rotation-renew-before"
            error={
              renewBeforeDays.length > 0 &&
              (!Number.isInteger(renewDays) || renewDays < 1 || renewDays > 365)
                ? i18n.t("admin.git-sync.rotation.days-error")
                : undefined
            }
          >
            <NumberInput
              id="git-token-rotation-renew-before"
              min={1}
              max={365}
              value={renewBeforeDays}
              onChange={(value) => setRenewBeforeDays(String(value))}
              disabled={isConfiguring || isRunning}
            />
          </FormRow>
          <FormRow
            label={i18n.t("admin.git-sync.rotation.requested-lifetime-days")}
            labelFor="git-token-rotation-lifetime"
            error={
              requestedLifetimeDays.length > 0 &&
              (!Number.isInteger(lifetimeDays) ||
                lifetimeDays < 1 ||
                lifetimeDays > 365 ||
                renewDays >= lifetimeDays)
                ? i18n.t("admin.git-sync.rotation.days-error")
                : undefined
            }
          >
            <NumberInput
              id="git-token-rotation-lifetime"
              min={1}
              max={365}
              value={requestedLifetimeDays}
              onChange={(value) => setRequestedLifetimeDays(String(value))}
              disabled={isConfiguring || isRunning}
            />
          </FormRow>
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={i18n.t("admin.git-sync.rotation.state")}
            >
              {stateLabel
                ? i18n.t(stateLabel)
                : i18n.t("admin.git-sync.rotation.state.not-configured")}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.git-sync.rotation.current-expiry")}
            >
              {profileDate(
                i18n.language,
                status?.currentCredentialExpiresAt,
                notAvailable,
              )}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.git-sync.rotation.next-attempt")}
            >
              {profileDate(i18n.language, status?.nextAttemptAt, notAvailable)}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.git-sync.rotation.last-attempt")}
            >
              {profileDate(i18n.language, status?.lastAttemptAt, notAvailable)}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.git-sync.rotation.last-success")}
            >
              {profileDate(i18n.language, status?.lastSuccessAt, notAvailable)}
            </SettingsDefinitionItem>
          </SettingsDefinitionList>
          {status?.state === GitTokenRotationState.ManualIntervention ? (
            <SettingsNotice tone="warning">
              {i18n.t("admin.git-sync.rotation.manual-intervention")}
            </SettingsNotice>
          ) : status?.diagnosis ? (
            <SettingsNotice tone="warning">{status.diagnosis}</SettingsNotice>
          ) : null}
          <SettingsToolbar justify="flex-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void rotateNow()}
              loading={isRunning}
              disabled={
                !status?.enabled ||
                status.state === GitTokenRotationState.Rotating ||
                status.state === GitTokenRotationState.ManualIntervention ||
                busy ||
                dirty
              }
            >
              {i18n.t("admin.git-sync.rotation.run-now")}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void saveRotation()}
              loading={isConfiguring}
              disabled={
                !configurationIsValid ||
                isRunning ||
                (status !== null && !dirty)
              }
            >
              {i18n.t("admin.actions.save")}
            </Button>
          </SettingsToolbar>
        </SettingsControlList>
      </FormFieldset>
    </Stack>
  );
}

function ProfileReadOnly({
  profile,
  workspaceId,
  onEdit,
  onDirtyChange,
  onBusyChange,
}: {
  profile: Profile;
  workspaceId: string;
  onEdit: () => void;
} & EditorLifecycle) {
  const i18n = useI18n();
  const statusQuery = useQuery({
    query: getGitSyncStatusQuery,
    variables: { workspaceId },
  });
  const { trigger: triggerSync, isMutating } = useMutation({
    mutation: triggerGitSyncMutation,
  });
  const lastRun = statusQuery.data?.workspace?.gitSyncStatus?.lastRun;
  const [rotationBusy, setRotationBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(isMutating || rotationBusy || syncBusy);
  }, [isMutating, rotationBusy, syncBusy, onBusyChange]);
  useEffect(() => {
    if (profile.authMethod !== GitSyncAuthMethod.HttpsToken)
      onDirtyChange?.(false);
  }, [profile.authMethod, onDirtyChange]);
  const notScheduled = i18n.t("com.myoxus.integration.git-sync.not-scheduled");

  async function runTestSync() {
    if (syncBusy || rotationBusy) return;
    setSyncBusy(true);
    try {
      await triggerSync({ workspaceId });
      notify.success({
        title: i18n.t("com.myoxus.integration.git-sync.sync-triggered"),
      });
      await statusQuery.mutate();
    } catch {
      notify.error({
        title: i18n.t("admin.git-sync.recovery.title"),
      });
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <Stack>
      <Group justify="space-between">
        <SettingsSectionHeading level={3}>
          {i18n.t("com.myoxus.integration.git-sync.section.profile")}
        </SettingsSectionHeading>
        <SettingsToolbar>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void runTestSync()}
            loading={isMutating}
            disabled={syncBusy || rotationBusy}
          >
            {i18n.t("com.myoxus.integration.git-sync.test-sync")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={onEdit}
            disabled={isMutating || rotationBusy || syncBusy}
          >
            {i18n.t("admin.actions.edit")}
          </Button>
        </SettingsToolbar>
      </Group>
      <SettingsDefinitionList>
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.field.repo-url")}
          mono
        >
          {profile.repoUrl}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.field.branch")}
          mono
        >
          {profile.branch}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.field.root-path")}
          mono
        >
          {profile.rootPath}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.field.direction")}
        >
          {i18n.t(GIT_SYNC_DIRECTION_LABELS[profile.syncDirection])}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.field.trigger")}
        >
          {i18n.t(GIT_SYNC_TRIGGER_LABELS[profile.triggerMode])}
        </SettingsDefinitionItem>
        {profile.triggerMode === GitSyncTriggerMode.Polling ? (
          <SettingsDefinitionItem
            label={i18n.t("com.myoxus.integration.git-sync.trigger.polling")}
          >
            {profile.pollingIntervalSecs ?? notScheduled} s
          </SettingsDefinitionItem>
        ) : null}
        {profile.triggerMode === GitSyncTriggerMode.Cron ? (
          <>
            <SettingsDefinitionItem
              label={i18n.t(
                "com.myoxus.integration.git-sync.field.cron-expression",
              )}
              mono
            >
              {profile.cronExpression}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("com.myoxus.common.timezone")}
            >
              {profile.cronTimezone}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t(
                "com.myoxus.integration.git-sync.field.misfire-policy",
              )}
            >
              {profile.cronMisfirePolicy
                ? i18n.t(GIT_SYNC_MISFIRE_LABELS[profile.cronMisfirePolicy])
                : notScheduled}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("com.myoxus.integration.git-sync.field.next-run")}
            >
              {profileDate(
                i18n.language,
                profile.cronNextScheduledAt,
                notScheduled,
              )}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t(
                "com.myoxus.integration.git-sync.field.pending-catch-up",
              )}
            >
              {profileDate(
                i18n.language,
                profile.cronPendingMisfireScheduledFor,
                notScheduled,
              )}
            </SettingsDefinitionItem>
          </>
        ) : null}
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.field.auth-method")}
        >
          {i18n.t(GIT_SYNC_AUTH_LABELS[profile.authMethod])}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("com.myoxus.integration.git-sync.last-run")}
        >
          {profileDate(
            i18n.language,
            lastRun?.scheduledFor ?? lastRun?.startedAt,
            notScheduled,
          )}
          {lastRun?.triggerSource
            ? ` · ${i18n.t(GIT_SYNC_RUN_SOURCE_LABELS[lastRun.triggerSource])}`
            : ""}
        </SettingsDefinitionItem>
      </SettingsDefinitionList>
      {profile.authMethod === GitSyncAuthMethod.HttpsToken ? (
        <TokenRotationEditor
          profileId={profile.id}
          onDirtyChange={onDirtyChange}
          onBusyChange={setRotationBusy}
        />
      ) : null}
    </Stack>
  );
}

function ProfileForm({
  workspaceId,
  profile,
  onCancel,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  workspaceId: string;
  profile: Profile | null;
  onCancel?: () => void;
  onSaved: () => Promise<void>;
} & EditorLifecycle) {
  const i18n = useI18n();
  const policyQuery = useQuery({ query: getGitSyncPoliciesQuery });
  const timezoneQuery = useQuery({ query: gitSyncTimezonesQuery });
  const policies = policyQuery.data?.serverConfig?.gitSync;
  const [repoUrl, setRepoUrl] = useState(profile?.repoUrl ?? "");
  const [branch, setBranch] = useState(
    profile?.branch ?? policies?.defaultBranch ?? "main",
  );
  const [rootPath, setRootPath] = useState(profile?.rootPath ?? "content/");
  const [syncDirection, setSyncDirection] = useState<GitSyncDirection>(
    profile?.syncDirection ?? GitSyncDirection.Bidirectional,
  );
  const [triggerMode, setTriggerMode] = useState<GitSyncTriggerMode>(
    profile?.triggerMode ?? GitSyncTriggerMode.Manual,
  );
  const [pollingInterval, setPollingInterval] = useState(
    String(profile?.pollingIntervalSecs ?? 300),
  );
  const [cronExpression, setCronExpression] = useState(
    profile?.cronExpression ?? "0 * * * *",
  );
  const [cronTimezone, setCronTimezone] = useState(
    profile?.cronTimezone ?? "UTC",
  );
  const [cronMisfirePolicy, setCronMisfirePolicy] =
    useState<GitSyncCronMisfirePolicy>(
      profile?.cronMisfirePolicy ?? GitSyncCronMisfirePolicy.Skip,
    );
  const [authMethod, setAuthMethod] = useState<GitSyncAuthMethod>(
    profile?.authMethod ?? GitSyncAuthMethod.HttpsToken,
  );
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [submitted, setSubmitted] = useState(false);
  const [saveErrorField, setSaveErrorField] = useState<ProfileField | null>(
    null,
  );
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const snapshot = JSON.stringify([
    repoUrl,
    branch,
    rootPath,
    syncDirection,
    triggerMode,
    pollingInterval,
    cronExpression,
    cronTimezone,
    cronMisfirePolicy,
    authMethod,
    token,
    username,
    password,
    sshPrivateKey,
    enabled,
  ]);
  const baseline = useRef(snapshot);
  const dirty = baseline.current !== snapshot;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!profile && !dirty && policies?.defaultBranch && branch === "main") {
      baseline.current = JSON.stringify([
        repoUrl,
        policies.defaultBranch,
        rootPath,
        syncDirection,
        triggerMode,
        pollingInterval,
        cronExpression,
        cronTimezone,
        cronMisfirePolicy,
        authMethod,
        token,
        username,
        password,
        sshPrivateKey,
        enabled,
      ]);
      setBranch(policies.defaultBranch);
    }
  }, [
    branch,
    policies?.defaultBranch,
    profile,
    dirty,
    repoUrl,
    rootPath,
    syncDirection,
    triggerMode,
    pollingInterval,
    cronExpression,
    cronTimezone,
    cronMisfirePolicy,
    authMethod,
    token,
    username,
    password,
    sshPrivateKey,
    enabled,
  ]);

  const previewEnabled =
    triggerMode === GitSyncTriggerMode.Cron &&
    cronExpression.trim().length > 0 &&
    cronTimezone.trim().length > 0;
  const previewQuery = useQuery(
    previewEnabled
      ? {
          query: gitSyncSchedulePreviewQuery,
          variables: {
            cron: cronExpression.trim(),
            cronTimezone,
            count: 5,
          },
        }
      : undefined,
  );
  const occurrences = previewQuery.data?.gitSyncSchedulePreview as
    ScheduleOccurrence[] | undefined;
  const scheduleIsValid =
    triggerMode !== GitSyncTriggerMode.Cron || occurrences?.length === 5;
  const pollingSeconds = Number(pollingInterval);
  const pollingIsValid =
    triggerMode !== GitSyncTriggerMode.Polling ||
    (Number.isInteger(pollingSeconds) && pollingSeconds > 0);
  const credentialsAreValid =
    profile !== null ||
    (authMethod === GitSyncAuthMethod.HttpsToken
      ? token.trim().length > 0
      : authMethod === GitSyncAuthMethod.HttpsPassword
        ? username.trim().length > 0 && password.length > 0
        : sshPrivateKey.trim().length > 0);
  const formIsValid =
    isValidRepoUrl(repoUrl) &&
    isValidBranch(branch) &&
    rootPath.trim().length > 0 &&
    pollingIsValid &&
    scheduleIsValid &&
    credentialsAreValid;
  const { trigger: createProfile, isMutating: isCreating } = useMutation({
    mutation: createGitSyncProfileMutation,
  });
  const { trigger: updateProfile, isMutating: isUpdating } = useMutation({
    mutation: updateGitSyncProfileMutation,
  });
  const { trigger: testConnection, isMutating: isTesting } = useMutation({
    mutation: testGitConnectionMutation,
  });
  const isSaving = isCreating || isUpdating;
  const busy = isSaving || isTesting || actionBusy;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const previewErrorField = serverErrorField(previewQuery.error);
  const previewErrorMessage = serverErrorMessage(
    previewQuery.error,
    i18n.t("admin.git-sync.recovery.title"),
  );

  const triggerOptions = useMemo(() => {
    const available: Array<{
      value: GitSyncTriggerMode;
      label: string;
      disabled?: boolean;
    }> = Object.values(GitSyncTriggerMode)
      .filter((value) => {
        if (
          value === GitSyncTriggerMode.Polling ||
          value === GitSyncTriggerMode.HistoryCapture
        ) {
          if (policies?.autoSyncAllowed === false) return false;
        }
        if (value === GitSyncTriggerMode.Webhook) {
          return policies?.webhookAllowed !== false;
        }
        return !(
          value === GitSyncTriggerMode.HistoryCapture &&
          syncDirection === GitSyncDirection.GitToMyoxus
        );
      })
      .map((value) => ({
        value,
        label: i18n.t(GIT_SYNC_TRIGGER_LABELS[value]),
      }));
    if (
      profile &&
      !available.some((option) => option.value === profile.triggerMode)
    ) {
      available.unshift({
        value: profile.triggerMode,
        label: i18n.t(GIT_SYNC_TRIGGER_LABELS[profile.triggerMode]),
        disabled: true,
      });
    }
    return available;
  }, [
    i18n,
    policies?.autoSyncAllowed,
    policies?.webhookAllowed,
    profile,
    syncDirection,
  ]);
  const directionOptions = useMemo(
    () =>
      Object.values(GitSyncDirection).map((value) => ({
        value,
        label: i18n.t(GIT_SYNC_DIRECTION_LABELS[value]),
      })),
    [i18n],
  );
  const authOptions = useMemo(
    () =>
      Object.values(GitSyncAuthMethod).map((value) => ({
        value,
        label: i18n.t(GIT_SYNC_AUTH_LABELS[value]),
      })),
    [i18n],
  );
  const timezoneOptions = useMemo(
    () =>
      (timezoneQuery.data?.gitSyncTimezones ?? []).map((value) => ({
        value,
        label: value,
      })),
    [timezoneQuery.data?.gitSyncTimezones],
  );

  const credentialInput = useCallback(() => {
    if (authMethod === GitSyncAuthMethod.HttpsToken) {
      return { token: token.trim() };
    }
    if (authMethod === GitSyncAuthMethod.HttpsPassword) {
      return { username: username.trim(), password };
    }
    return { sshPrivateKey: sshPrivateKey.trim() };
  }, [authMethod, password, sshPrivateKey, token, username]);

  async function testRemote() {
    if (busy) return;
    setActionBusy(true);
    try {
      const result = await testConnection({
        repoUrl: repoUrl.trim(),
        branch: branch.trim(),
        authMethod,
        ...credentialInput(),
      });
      if (!result.testGitConnection) throw new Error("connection rejected");
      notify.success({
        title: i18n.t("com.myoxus.integration.git-sync.connection-success"),
      });
    } catch {
      notify.error({
        title: i18n.t("com.myoxus.integration.git-sync.connection-failed"),
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function save() {
    if (busy) return;
    setSubmitted(true);
    setSaveErrorField(null);
    setSaveErrorMessage(null);
    if (!formIsValid) return;
    setActionBusy(true);
    const schedule = {
      pollingIntervalSecs:
        triggerMode === GitSyncTriggerMode.Polling ? pollingSeconds : null,
      cronExpression:
        triggerMode === GitSyncTriggerMode.Cron ? cronExpression.trim() : null,
      cronTimezone:
        triggerMode === GitSyncTriggerMode.Cron ? cronTimezone : null,
      cronMisfirePolicy:
        triggerMode === GitSyncTriggerMode.Cron ? cronMisfirePolicy : null,
    };
    try {
      if (profile) {
        await updateProfile({
          profileId: profile.id,
          input: {
            repoUrl: repoUrl.trim(),
            branch: branch.trim(),
            rootPath: rootPath.trim(),
            syncDirection,
            triggerMode,
            enabled,
            ...schedule,
          },
        });
      } else {
        await createProfile({
          workspaceId,
          input: {
            repoUrl: repoUrl.trim(),
            branch: branch.trim(),
            rootPath: rootPath.trim(),
            syncDirection,
            triggerMode,
            authMethod,
            ...credentialInput(),
            ...schedule,
          },
        });
      }
      await onSaved();
      baseline.current = snapshot;
      setSubmitted(false);
      onDirtyChange?.(false);
      notify.success({
        title: profile
          ? i18n.t("admin.actions.save")
          : i18n.t("com.myoxus.integration.git-sync.profile-created"),
      });
    } catch (error) {
      setSaveErrorField(serverErrorField(error));
      setSaveErrorMessage(
        serverErrorMessage(error, i18n.t("admin.git-sync.recovery.title")),
      );
      notify.error({
        title: i18n.t("admin.git-sync.recovery.title"),
      });
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <Stack>
      <SettingsSectionHeading level={3}>
        {profile
          ? i18n.t("admin.actions.edit")
          : i18n.t("com.myoxus.integration.git-sync.setup-title")}
      </SettingsSectionHeading>
      {saveErrorMessage && !saveErrorField ? (
        <SettingsNotice tone="error">{saveErrorMessage}</SettingsNotice>
      ) : null}
      <FormFieldset disabled={busy} variant="unstyled">
        <SettingsControlList>
          <FormRow
            label={i18n.t("com.myoxus.integration.git-sync.field.repo-url")}
            labelFor="git-sync-profile-repo-url"
            error={
              submitted && !isValidRepoUrl(repoUrl)
                ? i18n.t("com.myoxus.integration.git-sync.error.invalid-url")
                : undefined
            }
          >
            <Input
              id="git-sync-profile-repo-url"
              block
              value={repoUrl}
              onChange={setRepoUrl}
              placeholder="https://git.example.test/team/workspace.git"
            />
          </FormRow>
          <FormRow
            label={i18n.t("com.myoxus.integration.git-sync.field.branch")}
            labelFor="git-sync-profile-branch"
            error={
              submitted && !isValidBranch(branch)
                ? i18n.t("com.myoxus.integration.git-sync.error.invalid-branch")
                : undefined
            }
          >
            <Input
              id="git-sync-profile-branch"
              block
              value={branch}
              onChange={setBranch}
            />
          </FormRow>
          <FormRow
            label={i18n.t("com.myoxus.integration.git-sync.field.root-path")}
            labelFor="git-sync-profile-root"
          >
            <Input
              id="git-sync-profile-root"
              block
              value={rootPath}
              onChange={setRootPath}
            />
          </FormRow>
          <FormSelect
            label={i18n.t("com.myoxus.integration.git-sync.field.direction")}
            value={syncDirection}
            data={directionOptions}
            onChange={(value) => {
              const direction = value as GitSyncDirection;
              setSyncDirection(direction);
              if (
                direction === GitSyncDirection.GitToMyoxus &&
                triggerMode === GitSyncTriggerMode.HistoryCapture
              ) {
                setTriggerMode(GitSyncTriggerMode.Manual);
              }
            }}
          />
          <FormSelect
            label={i18n.t("com.myoxus.integration.git-sync.field.trigger")}
            value={triggerMode}
            data={triggerOptions}
            onChange={(value) => setTriggerMode(value as GitSyncTriggerMode)}
          />
          {triggerMode === GitSyncTriggerMode.HistoryCapture ? (
            <SettingsStatusText>
              {i18n.t(
                "com.myoxus.integration.git-sync.trigger.history-capture.description",
              )}
            </SettingsStatusText>
          ) : null}
          {triggerMode === GitSyncTriggerMode.Polling ? (
            <FormRow
              label={i18n.t("com.myoxus.integration.git-sync.trigger.polling")}
              labelFor="git-sync-profile-polling"
              error={
                (submitted && !pollingIsValid) ||
                saveErrorField === "pollingIntervalSecs"
                  ? (saveErrorMessage ??
                    i18n.t("admin.git-sync.recovery.title"))
                  : undefined
              }
            >
              <NumberInput
                id="git-sync-profile-polling"
                min={1}
                value={pollingInterval}
                onChange={(value) => setPollingInterval(String(value))}
                suffix=" s"
              />
            </FormRow>
          ) : null}
          {triggerMode === GitSyncTriggerMode.Cron ? (
            <>
              <FormRow
                label={i18n.t(
                  "com.myoxus.integration.git-sync.field.cron-expression",
                )}
                labelFor="git-sync-profile-cron"
                error={
                  previewQuery.error &&
                  (!previewErrorField || previewErrorField === "cronExpression")
                    ? previewErrorMessage
                    : saveErrorField === "cronExpression"
                      ? (saveErrorMessage ??
                        i18n.t("admin.git-sync.recovery.title"))
                      : undefined
                }
              >
                <Input
                  id="git-sync-profile-cron"
                  block
                  mono
                  value={cronExpression}
                  onChange={setCronExpression}
                  endFix={
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setCronExpression("0 * * * *")}
                      aria-label={i18n.t("admin.logging.rotation.hourly")}
                    >
                      {i18n.t("admin.logging.rotation.hourly")}
                    </Button>
                  }
                />
              </FormRow>
              <FormSelect
                label={i18n.t("com.myoxus.common.timezone")}
                value={cronTimezone}
                searchable
                data={timezoneOptions}
                onChange={setCronTimezone}
                disabled={
                  timezoneQuery.isLoading || Boolean(timezoneQuery.error)
                }
                error={
                  previewErrorField === "cronTimezone" ||
                  saveErrorField === "cronTimezone"
                    ? previewErrorField === "cronTimezone"
                      ? previewErrorMessage
                      : (saveErrorMessage ??
                        i18n.t("admin.git-sync.recovery.title"))
                    : undefined
                }
              />
              <FormSelect
                label={i18n.t(
                  "com.myoxus.integration.git-sync.field.misfire-policy",
                )}
                value={cronMisfirePolicy}
                data={Object.values(GitSyncCronMisfirePolicy).map((value) => ({
                  value,
                  label: i18n.t(GIT_SYNC_MISFIRE_LABELS[value]),
                }))}
                onChange={(value) =>
                  setCronMisfirePolicy(value as GitSyncCronMisfirePolicy)
                }
              />
              {previewQuery.isLoading ? (
                <SettingsStatusText>
                  {i18n.t("admin.common.loading")}
                </SettingsStatusText>
              ) : previewQuery.error && !previewErrorField ? (
                <SettingsNotice tone="error">
                  {previewErrorMessage}
                </SettingsNotice>
              ) : occurrences?.length ? (
                <SettingsDefinitionList data-testid="git-sync-cron-preview">
                  {occurrences.map((occurrence, index) => (
                    <SettingsDefinitionItem
                      key={occurrence.scheduledAtUtc}
                      label={`${i18n.t(
                        "com.myoxus.integration.git-sync.next-occurrence",
                      )} ${index + 1}`}
                      mono
                    >
                      {formatScheduleOccurrence(i18n.language, occurrence)}
                    </SettingsDefinitionItem>
                  ))}
                </SettingsDefinitionList>
              ) : null}
            </>
          ) : null}
          {profile ? (
            <SettingsSwitchRow
              label={i18n.t("admin.git-sync.profiles.status.enabled")}
              checked={enabled}
              onChange={setEnabled}
            />
          ) : (
            <>
              <FormSelect
                label={i18n.t(
                  "com.myoxus.integration.git-sync.field.auth-method",
                )}
                value={authMethod}
                data={authOptions}
                onChange={(value) => setAuthMethod(value as GitSyncAuthMethod)}
              />
              {authMethod === GitSyncAuthMethod.HttpsToken ? (
                <PasswordInput
                  label={i18n.t("com.myoxus.integration.git-sync.field.token")}
                  value={token}
                  onChange={setToken}
                />
              ) : null}
              {authMethod === GitSyncAuthMethod.HttpsPassword ? (
                <>
                  <Input
                    label={i18n.t(
                      "com.myoxus.integration.git-sync.field.username",
                    )}
                    block
                    value={username}
                    onChange={setUsername}
                  />
                  <PasswordInput
                    label={i18n.t(
                      "com.myoxus.integration.git-sync.field.password",
                    )}
                    value={password}
                    onChange={setPassword}
                  />
                </>
              ) : null}
              {authMethod === GitSyncAuthMethod.SshKey ? (
                <Textarea
                  label={i18n.t(
                    "com.myoxus.integration.git-sync.field.ssh-private-key",
                  )}
                  value={sshPrivateKey}
                  onChange={setSshPrivateKey}
                  mono
                />
              ) : null}
            </>
          )}
          <SettingsToolbar justify="flex-end">
            {onCancel ? (
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={isSaving || isTesting}
              >
                {i18n.t(
                  dirty
                    ? "admin.common.discard-changes"
                    : "admin.actions.cancel",
                )}
              </Button>
            ) : null}
            {!profile ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void testRemote()}
                loading={isTesting}
                disabled={
                  !isValidRepoUrl(repoUrl) || !credentialsAreValid || isSaving
                }
              >
                {i18n.t("com.myoxus.integration.git-sync.test-connection")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              onClick={() => void save()}
              loading={isSaving}
              disabled={
                isSaving ||
                (triggerMode === GitSyncTriggerMode.Cron &&
                  (previewQuery.isLoading || !scheduleIsValid))
              }
            >
              {profile
                ? i18n.t("admin.actions.save")
                : i18n.t("com.myoxus.integration.git-sync.create-profile")}
            </Button>
          </SettingsToolbar>
        </SettingsControlList>
      </FormFieldset>
    </Stack>
  );
}

export function GitSyncProfileEditor({
  workspaceId,
  onChanged,
  onDirtyChange,
  onBusyChange,
  onDiscard,
}: {
  workspaceId: string;
  onChanged: () => Promise<void>;
  onDiscard?: () => void;
} & EditorLifecycle) {
  const i18n = useI18n();
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingEdit, setPendingEdit] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const reportDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );
  const profileQuery = useQuery({
    query: getGitSyncProfileQuery,
    variables: { workspaceId },
  });
  const profile = (profileQuery.data?.workspace?.gitSyncProfile ??
    null) as Profile | null;

  async function refresh() {
    await profileQuery.mutate();
    await onChanged();
    setEditing(false);
  }

  if (profileQuery.isLoading && !profileQuery.data) {
    return <SettingsEmptyState title={i18n.t("admin.common.loading")} />;
  }
  if (profileQuery.error && !profileQuery.data) {
    return (
      <SettingsNotice tone="error">
        {i18n.t("admin.git-sync.recovery.title")}
      </SettingsNotice>
    );
  }
  return (
    <Stack>
      {profileQuery.error ? (
        <SettingsNotice tone="error">
          {i18n.t("admin.git-sync.recovery.title")}
        </SettingsNotice>
      ) : null}
      {!profile ? (
        <ProfileForm
          key={formVersion}
          workspaceId={workspaceId}
          profile={null}
          onSaved={refresh}
          onDirtyChange={reportDirty}
          onBusyChange={onBusyChange}
          onCancel={() => {
            reportDirty(false);
            if (onDiscard) onDiscard();
            else setFormVersion((value) => value + 1);
          }}
        />
      ) : editing ? (
        <ProfileForm
          workspaceId={workspaceId}
          profile={profile}
          onCancel={() => {
            reportDirty(false);
            setEditing(false);
          }}
          onSaved={refresh}
          onDirtyChange={reportDirty}
          onBusyChange={onBusyChange}
        />
      ) : (
        <>
          <ProfileReadOnly
            profile={profile}
            workspaceId={workspaceId}
            onEdit={() => {
              if (dirty) setPendingEdit(true);
              else setEditing(true);
            }}
            onDirtyChange={reportDirty}
            onBusyChange={onBusyChange}
          />
          <AdminConfirmModal
            open={pendingEdit}
            onOpenChange={setPendingEdit}
            title={i18n.t("admin.unsaved.discard-title")}
            description={i18n.t("admin.unsaved.discard-description")}
            confirmText={i18n.t("admin.common.discard-changes")}
            onConfirm={() => {
              reportDirty(false);
              setPendingEdit(false);
              setEditing(true);
            }}
          />
        </>
      )}
    </Stack>
  );
}
