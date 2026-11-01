import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import { GitContentPendingNotice } from "@myoxus/core/components/workspace-content-operation/git-pending";
import { Loading } from "@myoxus/ui-facade";
import { UserFriendlyError } from "@myoxus/error";
import {
  createGitSyncProfileMutation,
  deleteGitSyncProfileMutation,
  getGitSyncBindingsQuery,
  getGitSyncConflictsQuery,
  getGitSyncPoliciesQuery,
  getGitSyncProfileQuery,
  getGitSyncRunsQuery,
  getGitSyncStatusQuery,
  GitSyncAuthMethod,
  GitSyncConflictResolution,
  GitSyncCronMisfirePolicy,
  GitSyncDirection,
  GitSyncTriggerMode,
  resolveGitSyncConflictMutation,
  testGitConnectionMutation,
  triggerGitSyncMutation,
  updateGitSyncProfileMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { GithubIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  EmptyState,
  FormRow,
  FormSelect,
  Group,
  Input,
  MonoText,
  MyoxusTextarea,
  notify,
  SettingsControlEmpty,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSection,
  SettingsStatusText,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
} from "../../../primitives";
import { IntegrationSettingHeader } from "../setting";
import { isValidGitSyncBranch, isValidGitSyncRepoUrl } from "./validation";

// --- Types ---

interface GitSyncProfile {
  id: string;
  repoUrl: string;
  branch: string;
  rootPath: string;
  manifestPath: string;
  credentialInherited: boolean;
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
  createdAt: string;
  updatedAt: string;
}

interface GitSyncRun {
  id: string;
  direction: string;
  triggerSource: string;
  scheduledFor: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  docsCreated: number;
  docsUpdated: number;
  docsDeleted: number;
  conflictsFound: number;
  errorMessage: string | null;
}

interface GitSyncConflict {
  id: string;
  repoPath: string;
  conflictType: string;
  resolution: string | null;
  myoxusContent: string | null;
  gitContent: string | null;
  createdAt: string;
}

interface GitSyncBinding {
  id: string;
  docId: string;
  syncId: string;
  repoPath: string;
  tombstone: boolean;
}

// --- Sub-components ---

const GitSyncSettingHeader = ({ action }: { action?: ReactNode }) => {
  const t = useI18n();
  return (
    <IntegrationSettingHeader
      icon={<GithubIcon />}
      name={t["com.myoxus.integration.git-sync.name"]()}
      desc={t["com.myoxus.integration.git-sync.desc"]()}
      action={action}
    />
  );
};

function formatDate(
  language: string | undefined,
  iso: string | null | undefined,
): string {
  if (!iso) return "--";
  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "Completed"
      ? "success"
      : status === "Failed"
        ? "error"
        : "warning";
  return (
    <Badge tone={tone} data-myoxus-ui-role="git-sync-status-badge">
      {status}
    </Badge>
  );
}

// --- Profile Form (create / edit) ---

// Direction options with labels
const ALL_DIRECTIONS = [
  {
    value: GitSyncDirection.Bidirectional,
    label: "com.myoxus.integration.git-sync.direction.bidirectional",
  },
  {
    value: GitSyncDirection.MyoxusToGit,
    label: "com.myoxus.integration.git-sync.direction.push",
  },
  {
    value: GitSyncDirection.GitToMyoxus,
    label: "com.myoxus.integration.git-sync.direction.pull",
  },
] as const;

// Map server policy names to GraphQL enum values
const DIRECTION_POLICY_MAP: Record<string, GitSyncDirection> = {
  bidirectional: GitSyncDirection.Bidirectional,
  myoxus_to_git: GitSyncDirection.MyoxusToGit,
  git_to_myoxus: GitSyncDirection.GitToMyoxus,
};

const AUTH_METHOD_POLICY_MAP: Record<string, GitSyncAuthMethod> = {
  https_token: GitSyncAuthMethod.HttpsToken,
  https_password: GitSyncAuthMethod.HttpsPassword,
  ssh_key: GitSyncAuthMethod.SshKey,
};

const ALL_AUTH_METHODS = [
  {
    value: GitSyncAuthMethod.HttpsToken,
    label: "com.myoxus.integration.git-sync.auth.token",
  },
  {
    value: GitSyncAuthMethod.HttpsPassword,
    label: "com.myoxus.integration.git-sync.auth.https-password",
  },
  {
    value: GitSyncAuthMethod.SshKey,
    label: "com.myoxus.integration.git-sync.auth.ssh-key",
  },
] as const;

function ProfileForm({ onCreated }: { onCreated: () => void }) {
  const t = useI18n();
  const workspaceService = useService(WorkspaceService);
  const workspaceId = workspaceService.workspace.id;
  const directionLabels: Record<GitSyncDirection, string> = {
    [GitSyncDirection.Bidirectional]:
      t["com.myoxus.integration.git-sync.direction.bidirectional"](),
    [GitSyncDirection.MyoxusToGit]:
      t["com.myoxus.integration.git-sync.direction.push"](),
    [GitSyncDirection.GitToMyoxus]:
      t["com.myoxus.integration.git-sync.direction.pull"](),
  };
  const authLabels: Record<GitSyncAuthMethod, string> = {
    [GitSyncAuthMethod.HttpsToken]:
      t["com.myoxus.integration.git-sync.auth.token"](),
    [GitSyncAuthMethod.HttpsPassword]:
      t["com.myoxus.integration.git-sync.auth.https-password"](),
    [GitSyncAuthMethod.SshKey]:
      t["com.myoxus.integration.git-sync.auth.ssh-key"](),
  };

  // Load admin policies from serverConfig
  const { data: policiesData } = useQuery(
    {
      query: getGitSyncPoliciesQuery,
    },
    { suspense: false },
  );
  const policies = policiesData?.serverConfig?.gitSync;

  const directionOptions = useMemo(() => {
    const allowedValues = (policies?.allowedDirections ?? [])
      .map((d: string) => DIRECTION_POLICY_MAP[d])
      .filter((d): d is GitSyncDirection => Boolean(d));
    return allowedValues.length > 0
      ? ALL_DIRECTIONS.filter((d) => allowedValues.includes(d.value))
      : ALL_DIRECTIONS; // fallback: show all while policies are still loading
  }, [policies?.allowedDirections]);

  const authOptions = useMemo(() => {
    const allowedValues = (policies?.allowedAuthMethods ?? [])
      .map((a: string) => AUTH_METHOD_POLICY_MAP[a])
      .filter((a): a is GitSyncAuthMethod => Boolean(a));
    return allowedValues.length > 0
      ? ALL_AUTH_METHODS.filter((a) => allowedValues.includes(a.value))
      : ALL_AUTH_METHODS;
  }, [policies?.allowedAuthMethods]);

  const defaultBranch = policies?.defaultBranch ?? "main";
  const canUseAutomaticTriggers = policies?.autoSyncAllowed !== false;
  const canUseWebhook = policies?.webhookAllowed !== false;

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState(defaultBranch);
  const [rootPath, setRootPath] = useState("content/");
  const [syncDirection, setSyncDirection] = useState<GitSyncDirection>(
    directionOptions[0]?.value ?? GitSyncDirection.Bidirectional,
  );
  const [triggerMode, setTriggerMode] = useState<GitSyncTriggerMode>(
    GitSyncTriggerMode.Manual,
  );
  const [pollingInterval, setPollingInterval] = useState("300");
  const [authMethod, setAuthMethod] = useState<GitSyncAuthMethod>(
    authOptions[0]?.value ?? GitSyncAuthMethod.HttpsToken,
  );
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");

  const [urlError, setUrlError] = useState("");
  const [branchError, setBranchError] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<boolean | null>(
    null,
  );

  const { trigger: createProfile, isMutating: creating } = useMutation({
    mutation: createGitSyncProfileMutation,
  });

  const { trigger: testConnection } = useMutation({
    mutation: testGitConnectionMutation,
  });
  const hasCredential =
    (authMethod === GitSyncAuthMethod.HttpsToken && token.length > 0) ||
    (authMethod === GitSyncAuthMethod.HttpsPassword &&
      username.trim().length > 0 &&
      password.length > 0) ||
    (authMethod === GitSyncAuthMethod.SshKey &&
      sshPrivateKey.trim().length > 0);

  useEffect(() => {
    if (!branch) {
      setBranch(defaultBranch);
    }
  }, [branch, defaultBranch]);

  useEffect(() => {
    if (!directionOptions.some((option) => option.value === syncDirection)) {
      setSyncDirection(
        directionOptions[0]?.value ?? GitSyncDirection.Bidirectional,
      );
    }
  }, [directionOptions, syncDirection]);

  useEffect(() => {
    if (!authOptions.some((option) => option.value === authMethod)) {
      setAuthMethod(authOptions[0]?.value ?? GitSyncAuthMethod.HttpsToken);
    }
  }, [authMethod, authOptions]);

  useEffect(() => {
    if (
      triggerMode === GitSyncTriggerMode.HistoryCapture &&
      syncDirection === GitSyncDirection.GitToMyoxus
    ) {
      setTriggerMode(GitSyncTriggerMode.Manual);
    }
  }, [syncDirection, triggerMode]);

  const validateForm = useCallback((): boolean => {
    let valid = true;
    if (!isValidGitSyncRepoUrl(repoUrl)) {
      setUrlError(t["com.myoxus.integration.git-sync.error.invalid-url"]());
      valid = false;
    } else {
      setUrlError("");
    }
    if (!isValidGitSyncBranch(branch)) {
      setBranchError(
        t["com.myoxus.integration.git-sync.error.invalid-branch"](),
      );
      valid = false;
    } else {
      setBranchError("");
    }
    return valid;
  }, [repoUrl, branch, t]);

  const handleTestConnection = useAsyncCallback(async () => {
    if (!isValidGitSyncRepoUrl(repoUrl)) {
      setUrlError(t["com.myoxus.integration.git-sync.error.invalid-url"]());
      return;
    }
    setTestingConnection(true);
    setConnectionResult(null);
    try {
      const result = await testConnection({
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || defaultBranch,
        authMethod,
        ...(authMethod === GitSyncAuthMethod.HttpsToken ? { token } : {}),
        ...(authMethod === GitSyncAuthMethod.HttpsPassword
          ? { username: username.trim(), password }
          : {}),
        ...(authMethod === GitSyncAuthMethod.SshKey ? { sshPrivateKey } : {}),
      });
      const success = result.testGitConnection;
      setConnectionResult(success);
      if (success) {
        notify.success({
          title: t["com.myoxus.integration.git-sync.connection-success"](),
        });
      } else {
        notify.error({
          title: t["com.myoxus.integration.git-sync.connection-failed"](),
        });
      }
    } catch (err) {
      setConnectionResult(false);
      notify.error({
        error: UserFriendlyError.fromAny(err),
      });
    } finally {
      setTestingConnection(false);
    }
  }, [
    repoUrl,
    branch,
    defaultBranch,
    authMethod,
    token,
    username,
    password,
    sshPrivateKey,
    testConnection,
    t,
  ]);

  const handleCreate = useAsyncCallback(async () => {
    if (!validateForm()) return;
    const pollingIntervalSecs = Number(pollingInterval);
    if (
      triggerMode === GitSyncTriggerMode.Polling &&
      (!Number.isInteger(pollingIntervalSecs) || pollingIntervalSecs <= 0)
    ) {
      return;
    }
    try {
      await createProfile({
        workspaceId,
        input: {
          repoUrl: repoUrl.trim(),
          branch: branch.trim() || defaultBranch,
          rootPath: rootPath.trim() || "content/",
          syncDirection,
          triggerMode,
          pollingIntervalSecs:
            triggerMode === GitSyncTriggerMode.Polling
              ? pollingIntervalSecs
              : null,
          authMethod,
          ...(authMethod === GitSyncAuthMethod.HttpsToken ? { token } : {}),
          ...(authMethod === GitSyncAuthMethod.HttpsPassword
            ? { username: username.trim(), password }
            : {}),
          ...(authMethod === GitSyncAuthMethod.SshKey ? { sshPrivateKey } : {}),
        },
      });
      notify.success({
        title: t["com.myoxus.integration.git-sync.profile-created"](),
      });
      onCreated();
    } catch (err) {
      notify.error({
        error: UserFriendlyError.fromAny(err),
      });
    }
  }, [
    validateForm,
    createProfile,
    workspaceId,
    repoUrl,
    branch,
    defaultBranch,
    rootPath,
    syncDirection,
    triggerMode,
    pollingInterval,
    authMethod,
    token,
    username,
    password,
    sshPrivateKey,
    onCreated,
    t,
  ]);

  const handleInputChange = useCallback(
    (setter: (v: string) => void, errorSetter?: (v: string) => void) =>
      (value: string) => {
        setter(value);
        if (errorSetter) errorSetter("");
        setConnectionResult(null);
      },
    [],
  );
  const handleSyncDirectionChange = useCallback((value: string) => {
    setSyncDirection(value as GitSyncDirection);
    setConnectionResult(null);
  }, []);
  const handleTriggerModeChange = useCallback((value: string) => {
    setTriggerMode(value as GitSyncTriggerMode);
    setConnectionResult(null);
  }, []);
  const handleAuthMethodChange = useCallback((value: string) => {
    setAuthMethod(value as GitSyncAuthMethod);
    setConnectionResult(null);
  }, []);

  return (
    <Stack data-myoxus-ui-role="git-sync-profile-form">
      <FormRow
        label={t["com.myoxus.integration.git-sync.field.repo-url"]()}
        labelFor="git-sync-repo-url"
        error={urlError}
      >
        <Input
          id="git-sync-repo-url"
          type="text"
          value={repoUrl}
          onChange={handleInputChange(setRepoUrl, setUrlError)}
          placeholder="https://github.com/user/repo.git"
        />
      </FormRow>

      <FormRow
        label={t["com.myoxus.integration.git-sync.field.branch"]()}
        labelFor="git-sync-branch"
        error={branchError}
      >
        <Input
          id="git-sync-branch"
          type="text"
          value={branch}
          onChange={handleInputChange(setBranch, setBranchError)}
          placeholder="main"
        />
      </FormRow>

      <FormRow
        label={t["com.myoxus.integration.git-sync.field.root-path"]()}
        labelFor="git-sync-root-path"
      >
        <Input
          id="git-sync-root-path"
          type="text"
          value={rootPath}
          onChange={handleInputChange(setRootPath)}
          placeholder="/"
        />
      </FormRow>

      <FormRow
        label={t["com.myoxus.integration.git-sync.field.direction"]()}
        labelFor="git-sync-direction"
      >
        <FormSelect
          id="git-sync-direction"
          value={syncDirection}
          onChange={handleSyncDirectionChange}
          data={directionOptions.map((option) => ({
            value: option.value,
            label: directionLabels[option.value],
          }))}
        />
      </FormRow>

      <FormRow
        label={t["com.myoxus.integration.git-sync.field.trigger"]()}
        labelFor="git-sync-trigger"
      >
        <FormSelect
          id="git-sync-trigger"
          value={triggerMode}
          onChange={handleTriggerModeChange}
          data={[
            {
              value: GitSyncTriggerMode.Manual,
              label: t["com.myoxus.integration.git-sync.trigger.manual"](),
            },
            ...(canUseAutomaticTriggers
              ? [
                  {
                    value: GitSyncTriggerMode.Polling,
                    label:
                      t["com.myoxus.integration.git-sync.trigger.polling"](),
                  },
                ]
              : []),
            ...(canUseWebhook
              ? [
                  {
                    value: GitSyncTriggerMode.Webhook,
                    label:
                      t["com.myoxus.integration.git-sync.trigger.webhook"](),
                  },
                ]
              : []),
            ...(canUseAutomaticTriggers &&
            syncDirection !== GitSyncDirection.GitToMyoxus
              ? [
                  {
                    value: GitSyncTriggerMode.HistoryCapture,
                    label:
                      t[
                        "com.myoxus.integration.git-sync.trigger.history-capture"
                      ](),
                  },
                ]
              : []),
          ]}
        />
      </FormRow>

      {triggerMode === GitSyncTriggerMode.Polling ? (
        <FormRow
          label={t["com.myoxus.integration.git-sync.trigger.polling"]()}
          labelFor="git-sync-polling-interval"
        >
          <Input
            id="git-sync-polling-interval"
            type="number"
            min={1}
            value={pollingInterval}
            onChange={setPollingInterval}
          />
          {!Number.isInteger(Number(pollingInterval)) ||
          Number(pollingInterval) <= 0 ? (
            <SettingsListItemMeta tone="error">
              {t["com.myoxus.integration.git-sync.trigger.polling.invalid"]()}
            </SettingsListItemMeta>
          ) : null}
        </FormRow>
      ) : null}
      {triggerMode === GitSyncTriggerMode.HistoryCapture ? (
        <SettingsStatusText>
          {t[
            "com.myoxus.integration.git-sync.trigger.history-capture.description"
          ]()}
        </SettingsStatusText>
      ) : null}

      <FormRow
        label={t["com.myoxus.integration.git-sync.field.auth-method"]()}
        labelFor="git-sync-auth-method"
      >
        <FormSelect
          id="git-sync-auth-method"
          value={authMethod}
          onChange={handleAuthMethodChange}
          data={authOptions.map((option) => ({
            value: option.value,
            label: authLabels[option.value],
          }))}
        />
      </FormRow>

      {authMethod === GitSyncAuthMethod.HttpsToken ? (
        <FormRow
          label={t["com.myoxus.integration.git-sync.field.token"]()}
          labelFor="git-sync-token"
        >
          <Input
            id="git-sync-token"
            type="password"
            value={token}
            onChange={handleInputChange(setToken)}
            placeholder={t[
              "com.myoxus.integration.git-sync.field.token.placeholder"
            ]()}
          />
        </FormRow>
      ) : null}

      {authMethod === GitSyncAuthMethod.HttpsPassword ? (
        <>
          <FormRow
            label={t["com.myoxus.integration.git-sync.field.username"]()}
            labelFor="git-sync-username"
          >
            <Input
              id="git-sync-username"
              value={username}
              onChange={handleInputChange(setUsername)}
            />
          </FormRow>
          <FormRow
            label={t["com.myoxus.integration.git-sync.field.password"]()}
            labelFor="git-sync-password"
          >
            <Input
              id="git-sync-password"
              type="password"
              value={password}
              onChange={handleInputChange(setPassword)}
            />
          </FormRow>
        </>
      ) : null}

      {authMethod === GitSyncAuthMethod.SshKey ? (
        <FormRow
          label={t["com.myoxus.integration.git-sync.field.ssh-private-key"]()}
          labelFor="git-sync-ssh-private-key"
        >
          <MyoxusTextarea
            id="git-sync-ssh-private-key"
            value={sshPrivateKey}
            onChange={handleInputChange(setSshPrivateKey)}
            placeholder={t[
              "com.myoxus.integration.git-sync.field.token.ssh-placeholder"
            ]()}
          />
        </FormRow>
      ) : null}

      <Group
        justify="flex-end"
        data-myoxus-ui-role="git-sync-profile-form-actions"
      >
        <Button
          variant="secondary"
          onClick={handleTestConnection}
          disabled={testingConnection || !repoUrl || !hasCredential}
          loading={testingConnection}
        >
          {t["com.myoxus.integration.git-sync.test-connection"]()}
        </Button>
        <Button
          variant="primary"
          onClick={handleCreate}
          disabled={creating || !repoUrl || !hasCredential}
          loading={creating}
        >
          {t["com.myoxus.integration.git-sync.create-profile"]()}
        </Button>
      </Group>
      {connectionResult !== null ? (
        <SettingsStatusText tone={connectionResult ? "active" : "error"}>
          {connectionResult
            ? t["com.myoxus.integration.git-sync.connection-success"]()
            : t["com.myoxus.integration.git-sync.connection-failed"]()}
        </SettingsStatusText>
      ) : null}
    </Stack>
  );
}

// --- Run history ---

function RunHistory({ workspaceId }: { workspaceId: string }) {
  const t = useI18n();
  const { data } = useQuery(
    {
      query: getGitSyncRunsQuery,
      variables: { workspaceId, take: 10 },
    },
    { suspense: false },
  );

  const runs: GitSyncRun[] = data?.workspace?.gitSyncRuns ?? [];

  if (runs.length === 0) {
    return (
      <SettingsControlEmpty>
        {t["com.myoxus.integration.git-sync.no-runs"]()}
      </SettingsControlEmpty>
    );
  }

  return (
    <SurfaceList
      label={t["com.myoxus.integration.git-sync.section.history"]()}
      data-myoxus-ui-role="git-sync-run-list"
    >
      {runs.map((run) => (
        <SurfaceListItem
          key={run.id}
          component="div"
          layout="row"
          alignItems="center"
          justifyContent="space-between"
          data-myoxus-ui-role="git-sync-run-item"
        >
          <SurfaceListItemMain compact>
            <SettingsListItemTitle>
              {run.direction} - {formatDate(t.language, run.startedAt)}
            </SettingsListItemTitle>
            <SettingsListItemMeta>
              +{run.docsCreated} ~{run.docsUpdated} -{run.docsDeleted}
              {run.conflictsFound > 0
                ? ` | ${run.conflictsFound} ${t["com.myoxus.integration.git-sync.conflicts-label"]()}`
                : ""}
              {run.errorMessage ? ` | ${run.errorMessage}` : ""}
            </SettingsListItemMeta>
          </SurfaceListItemMain>
          <StatusBadge status={run.status} />
        </SurfaceListItem>
      ))}
    </SurfaceList>
  );
}

// --- Conflicts ---

function ConflictList({ workspaceId }: { workspaceId: string }) {
  const t = useI18n();
  const { data, mutate } = useQuery(
    {
      query: getGitSyncConflictsQuery,
      variables: { workspaceId },
    },
    { suspense: false },
  );

  const { trigger: resolveConflict } = useMutation({
    mutation: resolveGitSyncConflictMutation,
  });

  const conflicts: GitSyncConflict[] = data?.workspace?.gitSyncConflicts ?? [];

  const handleResolve = useAsyncCallback(
    async (conflictId: string, resolution: GitSyncConflictResolution) => {
      try {
        await resolveConflict({
          input: { conflictId, resolution },
        });
        notify.success({
          title: t["com.myoxus.integration.git-sync.conflict-resolved"](),
        });
        await mutate();
      } catch (err) {
        notify.error({
          error: UserFriendlyError.fromAny(err),
        });
      }
    },
    [resolveConflict, mutate, t],
  );

  if (conflicts.length === 0) {
    return (
      <SettingsControlEmpty>
        {t["com.myoxus.integration.git-sync.no-conflicts"]()}
      </SettingsControlEmpty>
    );
  }

  return (
    <SurfaceList
      label={t["com.myoxus.integration.git-sync.section.conflicts"]()}
      data-myoxus-ui-role="git-sync-conflict-list"
    >
      {conflicts.map((conflict) => (
        <SurfaceListItem
          key={conflict.id}
          component="div"
          data-myoxus-ui-role="git-sync-conflict-item"
        >
          <Group justify="space-between" align="center">
            <Stack>
              <MonoText>{conflict.repoPath}</MonoText>
              <SettingsListItemMeta>
                {conflict.conflictType}
              </SettingsListItemMeta>
            </Stack>
            <Group data-myoxus-ui-role="git-sync-conflict-actions">
              <Button
                variant="secondary"
                onClick={() =>
                  void handleResolve(
                    conflict.id,
                    GitSyncConflictResolution.MyoxusWins,
                  )
                }
              >
                {t["com.myoxus.integration.git-sync.resolve.keep-myoxus"]()}
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void handleResolve(
                    conflict.id,
                    GitSyncConflictResolution.GitWins,
                  )
                }
              >
                {t["com.myoxus.integration.git-sync.resolve.keep-git"]()}
              </Button>
            </Group>
          </Group>
        </SurfaceListItem>
      ))}
    </SurfaceList>
  );
}

// --- Bindings ---

function BindingList({ workspaceId }: { workspaceId: string }) {
  const t = useI18n();
  const { data } = useQuery(
    {
      query: getGitSyncBindingsQuery,
      variables: { workspaceId },
    },
    { suspense: false },
  );

  const bindings: GitSyncBinding[] = data?.workspace?.gitSyncBindings ?? [];

  if (bindings.length === 0) {
    return (
      <SettingsControlEmpty>
        {t["com.myoxus.integration.git-sync.no-bindings"]()}
      </SettingsControlEmpty>
    );
  }

  const activeBindings = bindings.filter((b) => !b.tombstone);

  return (
    <SurfaceList
      label={t["com.myoxus.integration.git-sync.section.bindings"]()}
      data-myoxus-ui-role="git-sync-binding-list"
    >
      {activeBindings.map((binding) => (
        <SurfaceListItem
          key={binding.id}
          component="div"
          density="compact"
          data-myoxus-ui-role="git-sync-binding-item"
        >
          <Group justify="space-between" align="center">
            <MonoText>{binding.repoPath}</MonoText>
            <SettingsListItemMeta>
              <MonoText>{binding.docId}</MonoText>
            </SettingsListItemMeta>
          </Group>
        </SurfaceListItem>
      ))}
      {activeBindings.length === 0 ? (
        <SettingsControlEmpty>
          {t["com.myoxus.integration.git-sync.no-bindings"]()}
        </SettingsControlEmpty>
      ) : null}
    </SurfaceList>
  );
}

function ProfileTriggerEditor({
  profile,
  onSaved,
}: {
  profile: GitSyncProfile;
  onSaved: () => Promise<unknown>;
}) {
  const t = useI18n();
  const { data: policiesData } = useQuery(
    { query: getGitSyncPoliciesQuery },
    { suspense: false },
  );
  const policies = policiesData?.serverConfig?.gitSync;
  const { trigger: updateProfile, isMutating } = useMutation({
    mutation: updateGitSyncProfileMutation,
  });
  const [editing, setEditing] = useState(false);
  const [triggerMode, setTriggerMode] = useState(profile.triggerMode);
  const [pollingInterval, setPollingInterval] = useState(
    String(profile.pollingIntervalSecs ?? 300),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setTriggerMode(profile.triggerMode);
      setPollingInterval(String(profile.pollingIntervalSecs ?? 300));
      setError(null);
    }
  }, [editing, profile.pollingIntervalSecs, profile.triggerMode]);

  const availableOptions = [
    {
      value: GitSyncTriggerMode.Manual,
      label: t["com.myoxus.integration.git-sync.trigger.manual"](),
    },
    ...(policies?.autoSyncAllowed !== false
      ? [
          {
            value: GitSyncTriggerMode.Polling,
            label: t["com.myoxus.integration.git-sync.trigger.polling"](),
          },
        ]
      : []),
    ...(policies?.webhookAllowed !== false
      ? [
          {
            value: GitSyncTriggerMode.Webhook,
            label: t["com.myoxus.integration.git-sync.trigger.webhook"](),
          },
        ]
      : []),
    ...(policies?.autoSyncAllowed !== false &&
    profile.syncDirection !== GitSyncDirection.GitToMyoxus
      ? [
          {
            value: GitSyncTriggerMode.HistoryCapture,
            label:
              t["com.myoxus.integration.git-sync.trigger.history-capture"](),
          },
        ]
      : []),
  ];
  const options = availableOptions.some(
    (option) => option.value === profile.triggerMode,
  )
    ? availableOptions
    : [
        {
          value: profile.triggerMode,
          label:
            profile.triggerMode === GitSyncTriggerMode.HistoryCapture
              ? t["com.myoxus.integration.git-sync.trigger.history-capture"]()
              : profile.triggerMode,
          disabled: true,
        },
        ...availableOptions,
      ];

  const save = useAsyncCallback(async () => {
    const seconds = Number(pollingInterval);
    if (
      triggerMode === GitSyncTriggerMode.Polling &&
      (!Number.isInteger(seconds) || seconds <= 0)
    ) {
      setError(t["com.myoxus.integration.git-sync.trigger.polling.invalid"]());
      return;
    }
    setError(null);
    try {
      await updateProfile({
        profileId: profile.id,
        input: {
          triggerMode,
          pollingIntervalSecs:
            triggerMode === GitSyncTriggerMode.Polling ? seconds : null,
        },
      });
      await onSaved();
      setEditing(false);
    } catch (cause) {
      setError(UserFriendlyError.fromAny(cause).message);
    }
  }, [onSaved, pollingInterval, profile.id, t, triggerMode, updateProfile]);

  if (!editing) {
    const label =
      options.find((option) => option.value === profile.triggerMode)?.label ??
      (profile.triggerMode === GitSyncTriggerMode.HistoryCapture
        ? t["com.myoxus.integration.git-sync.trigger.history-capture"]()
        : profile.triggerMode);
    return (
      <Group justify="space-between" align="center">
        <span>{label}</span>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {t["com.myoxus.integration.git-sync.trigger.edit"]()}
        </Button>
      </Group>
    );
  }

  return (
    <Stack>
      <FormSelect
        value={triggerMode}
        onChange={(value) => setTriggerMode(value as GitSyncTriggerMode)}
        data={options}
      />
      {triggerMode === GitSyncTriggerMode.Polling ? (
        <Input
          type="number"
          min={1}
          value={pollingInterval}
          onChange={setPollingInterval}
        />
      ) : null}
      {triggerMode === GitSyncTriggerMode.HistoryCapture ? (
        <SettingsStatusText>
          {t[
            "com.myoxus.integration.git-sync.trigger.history-capture.description"
          ]()}
        </SettingsStatusText>
      ) : null}
      {error ? (
        <SettingsListItemMeta tone="error">{error}</SettingsListItemMeta>
      ) : null}
      <Group justify="flex-end">
        <Button variant="secondary" onClick={() => setEditing(false)}>
          {t["com.myoxus.integration.git-sync.trigger.cancel"]()}
        </Button>
        <Button
          variant="primary"
          onClick={save}
          loading={isMutating}
          disabled={isMutating}
        >
          {t["com.myoxus.integration.git-sync.trigger.save"]()}
        </Button>
      </Group>
    </Stack>
  );
}

// --- Main Panel ---

export const GitSyncSettingPanel = () => {
  // Check if Git Sync is enabled by admin
  const { data: policiesData } = useQuery(
    {
      query: getGitSyncPoliciesQuery,
    },
    { suspense: false },
  );
  const gitSyncEnabled = policiesData?.serverConfig?.gitSync?.enabled ?? false;

  if (!policiesData) return <Loading />;
  return <GitSyncSettingPanelContent gitSyncEnabled={gitSyncEnabled} />;
};

const GitSyncSettingPanelContent = ({
  gitSyncEnabled,
}: {
  gitSyncEnabled: boolean;
}) => {
  const t = useI18n();
  const workspaceService = useService(WorkspaceService);
  const workspaceId = workspaceService.workspace.id;
  const operations = useService(WorkspaceContentOperationService);
  const dialogs = useService(WorkspaceDialogService);

  const { data: statusData, mutate: mutateStatus } = useQuery(
    {
      query: getGitSyncStatusQuery,
      variables: { workspaceId },
    },
    { suspense: false },
  );

  const { data: profileData, mutate: mutateProfile } = useQuery(
    {
      query: getGitSyncProfileQuery,
      variables: { workspaceId },
    },
    { suspense: false },
  );

  const { trigger: triggerSync, isMutating: syncing } = useMutation({
    mutation: triggerGitSyncMutation,
  });

  const { trigger: deleteProfile, isMutating: deleting } = useMutation({
    mutation: deleteGitSyncProfileMutation,
  });

  const [showForm, setShowForm] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const profile: GitSyncProfile | null =
    profileData?.workspace?.gitSyncProfile ?? null;
  const status = statusData?.workspace?.gitSyncStatus ?? null;
  const lastRun: GitSyncRun | null = status?.lastRun ?? null;
  const pendingOperations =
    statusData?.workspace?.pendingGitContentOperations ?? [];
  const pollPending = pendingOperations.some(
    (operation) => !operation.gitSyncRetryExhausted,
  );
  useEffect(() => {
    if (!pollPending) return;
    const timer = setInterval(() => {
      void mutateStatus();
      void mutateProfile();
    }, 1500);
    return () => clearInterval(timer);
  }, [pollPending, mutateStatus, mutateProfile]);
  const pendingNotice = pendingOperations.map((operation) => (
    <Stack key={operation.id}>
      <GitContentPendingNotice operation={operation} />
      <Group>
        <Button
          variant="secondary"
          onClick={() =>
            dialogs.open("workspace-content-operation", {
              resumeOperationId: operation.id,
            })
          }
        >
          {t["Continue"]()}
        </Button>
        <Button
          variant="secondary"
          disabled={retrying || !gitSyncEnabled}
          loading={retrying}
          onClick={() =>
            void (async () => {
              setRetrying(true);
              try {
                await operations.retry(operation.id);
                await mutateStatus();
              } catch {
                notify.error({
                  title:
                    t["com.myoxus.workspace-content-operation.error.retry"](),
                });
              } finally {
                setRetrying(false);
              }
            })()
          }
        >
          {t["Retry"]()}
        </Button>
      </Group>
    </Stack>
  ));

  const handleTriggerSync = useAsyncCallback(async () => {
    try {
      await triggerSync({ workspaceId });
      notify.success({
        title: t["com.myoxus.integration.git-sync.sync-triggered"](),
      });
      // Refresh status after a short delay to pick up the new run
      setTimeout(() => {
        void mutateStatus();
      }, 2000);
    } catch (err) {
      notify.error({
        error: UserFriendlyError.fromAny(err),
      });
    }
  }, [triggerSync, workspaceId, mutateStatus, t]);

  const handleDeleteProfile = useAsyncCallback(async () => {
    if (!profile) return;
    try {
      await deleteProfile({ profileId: profile.id });
      notify.success({
        title: t["com.myoxus.integration.git-sync.profile-deleted"](),
      });
      await mutateProfile();
      await mutateStatus();
    } catch (err) {
      notify.error({
        error: UserFriendlyError.fromAny(err),
      });
    }
  }, [profile, deleteProfile, mutateProfile, mutateStatus, t]);

  const handleProfileCreated = useCallback(() => {
    setShowForm(false);
    void mutateProfile();
    void mutateStatus();
  }, [mutateProfile, mutateStatus]);

  // No profile configured yet
  if (!profileData || !statusData) return <Loading />;
  if (!profile && (!showForm || !gitSyncEnabled)) {
    return (
      <Stack>
        <GitSyncSettingHeader />
        {pendingNotice}
        <EmptyState
          title={
            gitSyncEnabled
              ? t["com.myoxus.integration.git-sync.no-profile"]()
              : t["com.myoxus.integration.git-sync.disabled-by-admin"]()
          }
          cta={
            gitSyncEnabled ? (
              <Button
                variant="primary"
                onClick={() => setShowForm(true)}
                data-testid="git-sync-create-profile"
                disabled={pendingOperations.length > 0}
              >
                {t["com.myoxus.integration.git-sync.create-profile"]()}
              </Button>
            ) : undefined
          }
        />
      </Stack>
    );
  }

  // Show creation form
  if (!profile && showForm && gitSyncEnabled) {
    return (
      <Stack>
        <GitSyncSettingHeader />
        {pendingNotice}
        <SettingsSection
          title={t["com.myoxus.integration.git-sync.setup-title"]()}
        >
          <ProfileForm onCreated={handleProfileCreated} />
        </SettingsSection>
      </Stack>
    );
  }

  // Profile exists: show full management UI.
  return (
    <Stack>
      <GitSyncSettingHeader />
      {pendingNotice}
      {!gitSyncEnabled ? (
        <SettingsStatusText>
          {t["com.myoxus.integration.git-sync.disabled-by-admin"]()}
        </SettingsStatusText>
      ) : null}
      {profile && !profile.enabled ? (
        <Badge tone="warning">
          {t["com.myoxus.integration.git-sync.paused"]()}
        </Badge>
      ) : null}

      {/* Profile overview */}
      <SettingsSection
        title={t["com.myoxus.integration.git-sync.section.profile"]()}
        actions={
          profile?.triggerMode === GitSyncTriggerMode.Cron ? undefined : (
            <Button
              variant="error"
              onClick={handleDeleteProfile}
              disabled={deleting}
              loading={deleting}
            >
              {t["com.myoxus.integration.git-sync.delete-profile"]()}
            </Button>
          )
        }
      >
        <SettingsDefinitionList>
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.repo-url"]()}
            mono
          >
            {profile?.repoUrl}
          </SettingsDefinitionItem>
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.branch"]()}
            mono
          >
            {profile?.branch}
          </SettingsDefinitionItem>
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.direction"]()}
          >
            {profile?.syncDirection}
          </SettingsDefinitionItem>
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.root-path"]()}
            mono
          >
            {profile?.rootPath}
          </SettingsDefinitionItem>
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.manifest-path"]()}
            mono
          >
            {profile?.manifestPath}
          </SettingsDefinitionItem>
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.trigger"]()}
          >
            {profile?.triggerMode === GitSyncTriggerMode.Cron ? (
              profile.triggerMode
            ) : profile ? (
              <ProfileTriggerEditor profile={profile} onSaved={mutateProfile} />
            ) : null}
          </SettingsDefinitionItem>
          {profile?.triggerMode === GitSyncTriggerMode.Cron ? (
            <>
              <SettingsDefinitionItem
                label={t[
                  "com.myoxus.integration.git-sync.field.cron-expression"
                ]()}
                mono
              >
                {profile.cronExpression}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem label={t["com.myoxus.common.timezone"]()}>
                {profile.cronTimezone}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem
                label={t[
                  "com.myoxus.integration.git-sync.field.misfire-policy"
                ]()}
              >
                {profile.cronMisfirePolicy === GitSyncCronMisfirePolicy.RunOnce
                  ? t["com.myoxus.integration.git-sync.misfire.run-once"]()
                  : t["com.myoxus.integration.git-sync.misfire.skip"]()}
              </SettingsDefinitionItem>
              <SettingsDefinitionItem
                label={t["com.myoxus.integration.git-sync.field.next-run"]()}
              >
                {formatDate(t.language, profile.cronNextScheduledAt)}
              </SettingsDefinitionItem>
              {profile.cronPendingMisfireScheduledFor ? (
                <SettingsDefinitionItem
                  label={t[
                    "com.myoxus.integration.git-sync.field.pending-catch-up"
                  ]()}
                >
                  {formatDate(
                    t.language,
                    profile.cronPendingMisfireScheduledFor,
                  )}
                </SettingsDefinitionItem>
              ) : null}
            </>
          ) : null}
          <SettingsDefinitionItem
            label={t["com.myoxus.integration.git-sync.field.auth-method"]()}
          >
            {profile?.authMethod}
          </SettingsDefinitionItem>
        </SettingsDefinitionList>
        {profile?.credentialInherited ? (
          <SettingsStatusText>
            {t["com.myoxus.integration.git-sync.credential-inherited"]()}
          </SettingsStatusText>
        ) : null}
        {profile?.triggerMode === GitSyncTriggerMode.Cron ? (
          <SettingsStatusText>
            {t["com.myoxus.integration.git-sync.cron-admin-managed"]()}
          </SettingsStatusText>
        ) : null}
      </SettingsSection>

      {/* Status + manual sync */}
      <SettingsSection
        title={t["com.myoxus.integration.git-sync.section.status"]()}
        actions={
          <Button
            variant="primary"
            onClick={handleTriggerSync}
            disabled={syncing || !profile?.enabled || !gitSyncEnabled}
            loading={syncing}
          >
            {t["com.myoxus.integration.git-sync.trigger-sync"]()}
          </Button>
        }
      >
        {lastRun ? (
          <Stack>
            <SettingsStatusText>
              {t["com.myoxus.integration.git-sync.last-run"]()}:{" "}
              {formatDate(t.language, lastRun.startedAt)}{" "}
              <StatusBadge status={lastRun.status} />
            </SettingsStatusText>
            {lastRun.errorMessage ? (
              <SettingsListItemMeta tone="error">
                {lastRun.errorMessage}
              </SettingsListItemMeta>
            ) : null}
            <SettingsListItemMeta>
              +{lastRun.docsCreated} ~{lastRun.docsUpdated} -
              {lastRun.docsDeleted}
              {status?.openConflicts
                ? ` | ${status.openConflicts} ${t["com.myoxus.integration.git-sync.open-conflicts"]()}`
                : ""}
              {status?.totalBindings
                ? ` | ${status.totalBindings} ${t["com.myoxus.integration.git-sync.total-bindings"]()}`
                : ""}
            </SettingsListItemMeta>
          </Stack>
        ) : (
          <SettingsControlEmpty>
            {t["com.myoxus.integration.git-sync.no-runs"]()}
          </SettingsControlEmpty>
        )}
      </SettingsSection>

      <Accordion multiple>
        <AccordionItem value="history">
          <AccordionControl>
            {t["com.myoxus.integration.git-sync.section.history"]()}
          </AccordionControl>
          <AccordionPanel flushHorizontal>
            <RunHistory workspaceId={workspaceId} />
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="conflicts">
          <AccordionControl>
            {t["com.myoxus.integration.git-sync.section.conflicts"]()}
          </AccordionControl>
          <AccordionPanel flushHorizontal>
            <ConflictList workspaceId={workspaceId} />
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="bindings">
          <AccordionControl>
            {t["com.myoxus.integration.git-sync.section.bindings"]()}
          </AccordionControl>
          <AccordionPanel flushHorizontal>
            <BindingList workspaceId={workspaceId} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Stack>
  );
};
