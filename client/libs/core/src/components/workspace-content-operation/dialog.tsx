// SPDX-License-Identifier: AGPL-3.0-or-later

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import {
  clearWorkspaceContentOperationFromLocation,
  projectWorkspaceContentOperationToLocation,
  WorkspaceContentOperationService,
} from "@myoxus/core/modules/workspace-content-operation";
import { UserFriendlyError } from "@myoxus/error";
import {
  type Permission,
  type WorkspaceContentBlockerType,
  type WorkspaceContentConfirmationKindType,
  type WorkspaceContentConflictKindType,
  WorkspaceContentErrorCodeType,
  WorkspaceContentGitSyncChoiceType,
  WorkspaceContentOperationKindType,
  type WorkspaceContentOperationProjectionFragment,
  WorkspaceContentOperationStatusType,
  type WorkspaceContentPreflightProjectionFragment,
  type WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { useI18n, workspaceContentFailureKey } from "@myoxus/i18n";
import { OpenInNewIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  Checkbox,
  Group,
  Loading,
  Modal,
  MyoxusText,
  MyoxusTextInput,
  Select,
  SettingsNotice,
  SettingsDefinitionList,
  SettingsDefinitionItem,
  Stack,
  Stepper,
  StepperStep,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitContentPendingNotice } from "./git-pending";

type DialogProps = DialogComponentProps<
  WORKSPACE_DIALOG_SCHEMA["workspace-content-operation"]
>;

const TERMINAL_STATUSES = new Set([
  WorkspaceContentOperationStatusType.Cancelled,
  WorkspaceContentOperationStatusType.CleanupRequired,
  WorkspaceContentOperationStatusType.Failed,
  WorkspaceContentOperationStatusType.Succeeded,
]);

function confirmationKey(
  confirmation: WorkspaceContentPreflightProjectionFragment["requiredConfirmations"][number],
) {
  return [
    confirmation.kind,
    confirmation.userId,
    confirmation.role,
    confirmation.resource?.workspaceId,
    confirmation.resource?.kind,
    confirmation.resource?.id,
  ].join(":");
}

export function WorkspaceContentOperationDialog(props: DialogProps) {
  const t = useI18n();
  const service = useService(WorkspaceContentOperationService);
  const availability = useLiveData(service.availability$);
  const navigate = useNavigateHelper();
  const [stage, setStage] = useState<"target" | "review" | "progress">(
    props.resumeOperationId ? "progress" : "target",
  );
  const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
  const [extractName, setExtractName] = useState(props.selection?.label ?? "");
  const [gitSyncChoice, setGitSyncChoice] = useState(
    WorkspaceContentGitSyncChoiceType.Move,
  );
  const [linkFolderId, setLinkFolderId] = useState("");
  const [linkFolders, setLinkFolders] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [preview, setPreview] =
    useState<WorkspaceContentPreflightProjectionFragment | null>(null);
  const [operation, setOperation] =
    useState<WorkspaceContentOperationProjectionFragment | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    // A terminal route remains resumable until its result is explicitly closed.
    // Changing the route while loading it can dispose the opening dialog scope.
    if (operation && TERMINAL_STATUSES.has(operation.status)) {
      clearWorkspaceContentOperationFromLocation(operation.id);
    }
    props.close();
  }, [operation, props.close]);

  const selection = props.selection;
  const kind = preview?.operation.kind ?? operation?.kind ?? props.kind;
  const isExtract = kind === WorkspaceContentOperationKindType.ExtractFolder;
  const isLink = kind === WorkspaceContentOperationKindType.Link;
  const gitConfigured =
    availability.status !== "unavailable" &&
    availability.gitConfigured === true;
  const targets =
    availability.status === "available" ? availability.targets : [];

  useEffect(() => {
    void service.refreshAvailability(true);
  }, [service]);

  useEffect(() => {
    if (!props.resumeOperationId) return;
    let active = true;
    setBusy(true);
    void service
      .operation(props.resumeOperationId)
      .then((next) => {
        if (!active) return;
        setOperation(next);
        setError(null);
      })
      .catch(() => {
        if (!active) return;
        setError(t["com.myoxus.workspace-content-operation.error.reconnect"]());
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [props.resumeOperationId, service, t]);

  useEffect(() => {
    if (!isLink || !targetWorkspaceId) {
      setLinkFolders([]);
      setLinkFolderId("");
      return;
    }
    let active = true;
    setBusy(true);
    setError(null);
    void service
      .targetLinkFolders(targetWorkspaceId)
      .then((folders) => {
        if (!active) return;
        setLinkFolders(folders);
        setLinkFolderId(folders[0]?.id ?? "");
      })
      .catch(() => {
        if (active) {
          setError(
            t[
              "com.myoxus.workspace-content-operation.error.target-unavailable"
            ](),
          );
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [isLink, service, t, targetWorkspaceId]);

  useEffect(() => {
    if (
      stage !== "progress" ||
      !operation ||
      (TERMINAL_STATUSES.has(operation.status) &&
        (!operation.gitSyncPending || operation.gitSyncRetryExhausted))
    ) {
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const next = await service.operation(operation.id);
        if (active) {
          setError(null);
          setOperation(next);
        }
      } catch {
        if (active) {
          setError(
            t["com.myoxus.workspace-content-operation.error.reconnect"](),
          );
        }
      }
    };
    const timer = setInterval(() => void poll(), 1_500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operation, service, stage, t]);

  const title = kind
    ? operationTitle(t, kind)
    : t["com.myoxus.workspace-content-operation.step.progress"]();
  const targetData = useMemo(
    () =>
      targets.map((workspace) => ({
        value: workspace.id,
        label: workspace.name ?? workspace.id,
      })),
    [targets],
  );
  const linkFolderData = useMemo(
    () =>
      linkFolders.map((folder) => ({
        value: folder.id,
        label: folder.name,
      })),
    [linkFolders],
  );
  const canPreview = isExtract
    ? extractName.trim().length > 0
    : targetWorkspaceId.length > 0 && (!isLink || linkFolderId.length > 0);

  const startPreview = useCallback(async () => {
    if (!canPreview || !kind || !selection) return;
    setBusy(true);
    setError(null);
    try {
      const linkPlacement =
        isLink && targetWorkspaceId && linkFolderId
          ? await service.createLinkPlacement(targetWorkspaceId, linkFolderId)
          : undefined;
      const next = await service.preflight({
        kind,
        selection,
        targetWorkspaceId: isExtract ? undefined : targetWorkspaceId,
        extractWorkspaceName: isExtract ? extractName.trim() : undefined,
        gitSyncChoice: isExtract && gitConfigured ? gitSyncChoice : undefined,
        linkPlacement,
      });
      setPreview(next);
      setConfirmed(new Set());
      setStage("review");
    } catch (cause) {
      const diagnosticKey = workspaceContentFailureKey(
        null,
        UserFriendlyError.fromAny(cause).name,
      );
      setError(
        diagnosticKey
          ? t[diagnosticKey]()
          : t["com.myoxus.workspace-content-operation.error.preflight"](),
      );
    } finally {
      setBusy(false);
    }
  }, [
    canPreview,
    extractName,
    gitSyncChoice,
    gitConfigured,
    isExtract,
    isLink,
    kind,
    linkFolderId,
    selection,
    service,
    t,
    targetWorkspaceId,
  ]);

  const execute = useCallback(async () => {
    if (
      !preview ||
      preview.blockers.length > 0 ||
      preview.requiredConfirmations.some(
        (confirmation) => !confirmed.has(confirmationKey(confirmation)),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await service.execute(preview);
      setOperation(next);
      projectWorkspaceContentOperationToLocation(next.id);
      setStage("progress");
    } catch (cause) {
      const causeName: string = UserFriendlyError.fromAny(cause).name;
      if (causeName === "XWS_PREFLIGHT_STALE") {
        setPreview(null);
        setConfirmed(new Set());
        setStage(preview.operation.originOperationId ? "progress" : "target");
        setError(
          t["com.myoxus.workspace-content-operation.error.preview-stale"](),
        );
      } else {
        setError(t["com.myoxus.workspace-content-operation.error.execute"]());
      }
    } finally {
      setBusy(false);
    }
  }, [confirmed, preview, service, t]);

  const cancel = useCallback(async () => {
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const next = await service.cancel(operation.id);
      setOperation(next);
    } catch {
      setError(t["com.myoxus.workspace-content-operation.error.cancel"]());
    } finally {
      setBusy(false);
    }
  }, [operation, service, t]);

  const retry = useCallback(async () => {
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const next = await service.retry(operation.id);
      setOperation(next);
      projectWorkspaceContentOperationToLocation(next.id);
    } catch {
      setError(t["com.myoxus.workspace-content-operation.error.retry"]());
    } finally {
      setBusy(false);
    }
  }, [operation, service, t]);

  const prepareUndo = useCallback(
    async (originOperationId: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = await service.undo(originOperationId);
        setPreview(next);
        setConfirmed(new Set());
        setStage("review");
      } catch (cause) {
        const key = workspaceContentFailureKey(
          null,
          UserFriendlyError.fromAny(cause).name,
        );
        setError(
          t[key ?? "com.myoxus.workspace-content-operation.error.preflight"](),
        );
      } finally {
        setBusy(false);
      }
    },
    [service, t],
  );

  const reviewAgain = useCallback(() => {
    if (operation?.originOperationId) {
      void prepareUndo(operation.originOperationId);
      return;
    }
    if (!selection) return;
    if (operation) clearWorkspaceContentOperationFromLocation(operation.id);
    setPreview(null);
    setOperation(null);
    setConfirmed(new Set());
    setStage("target");
    setError(null);
  }, [operation, prepareUndo, selection]);

  const openTarget = useCallback(async () => {
    if (isExtract && operation?.targetWorkspaceId) {
      setBusy(true);
      setError(null);
      try {
        const target = await service.resolveExtractedWorkspace(operation.id);
        if (!target) {
          setError(
            t["com.myoxus.workspace-content-operation.error.target-denied"](),
          );
          return;
        }
        navigate.jumpToWorkspaceOverview(target);
        close();
      } catch {
        setError(
          t["com.myoxus.workspace-content-operation.error.target-denied"](),
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (
      kind !== WorkspaceContentOperationKindType.Move ||
      selection?.type !== "resources" ||
      selection.resources.length !== 1
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const redirected = await service.resolveRedirect({
        workspaceId: operation?.sourceWorkspaceId ?? "",
        resource: selection.resources[0],
      });
      if (!redirected) {
        setError(
          t["com.myoxus.workspace-content-operation.error.target-denied"](),
        );
        return;
      }
      navigate.jumpToWorkspaceResource(redirected);
      close();
    } catch {
      setError(
        t["com.myoxus.workspace-content-operation.error.target-denied"](),
      );
    } finally {
      setBusy(false);
    }
  }, [close, isExtract, kind, navigate, operation, selection, service, t]);

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      persistent={busy}
      scrollable
      title={title}
      width="lg"
      contentOptions={{ "data-testid": "workspace-content-operation-dialog" }}
    >
      <Stack gap="lg">
        <Stepper
          active={stage === "target" ? 0 : stage === "review" ? 1 : 2}
          ariaLabel={title}
          uiRole="workspace-content-operation-stepper"
        >
          <StepperStep
            label={t["com.myoxus.workspace-content-operation.step.target"]()}
          />
          <StepperStep
            label={t["com.myoxus.workspace-content-operation.step.review"]()}
          />
          <StepperStep
            label={t["com.myoxus.workspace-content-operation.step.progress"]()}
          />
        </Stepper>

        {error ? (
          <SettingsNotice tone="error" role="alert">
            {error}
          </SettingsNotice>
        ) : null}

        {stage === "target" ? (
          <TargetStage
            extractName={extractName}
            isExtract={isExtract}
            gitConfigured={gitConfigured}
            gitSyncChoice={gitSyncChoice}
            onGitChoiceChange={(choice) => {
              setGitSyncChoice(choice);
              setPreview(null);
              setConfirmed(new Set());
            }}
            isLink={isLink}
            linkFolderData={linkFolderData}
            linkFolderId={linkFolderId}
            loading={busy || availability.status === "checking"}
            onExtractNameChange={setExtractName}
            onLinkFolderChange={setLinkFolderId}
            onTargetChange={setTargetWorkspaceId}
            targetData={targetData}
            targetWorkspaceId={targetWorkspaceId}
          />
        ) : null}

        {stage === "review" && preview && kind ? (
          <ReviewStage
            confirmed={confirmed}
            kind={kind}
            onConfirmedChange={setConfirmed}
            preview={preview}
          />
        ) : null}

        {stage === "progress" && operation ? (
          <ProgressStage operation={operation} />
        ) : null}

        <Group justify="space-between" wrap="wrap">
          <Button disabled={busy} onClick={() => close()} variant="plain">
            {TERMINAL_STATUSES.has(
              operation?.status ?? WorkspaceContentOperationStatusType.Draft,
            )
              ? t["com.myoxus.workspace-content-operation.action.close"]()
              : t["com.myoxus.workspace-content-operation.action.dismiss"]()}
          </Button>
          <Group wrap="wrap">
            {stage === "review" ? (
              <Button
                disabled={busy}
                onClick={() => {
                  if (preview?.operation.originOperationId) {
                    setPreview(null);
                    setStage("progress");
                  } else {
                    setStage("target");
                  }
                }}
                variant="secondary"
              >
                {t["com.myoxus.workspace-content-operation.action.back"]()}
              </Button>
            ) : null}
            {stage === "target" ? (
              <Button
                disabled={!canPreview || busy}
                loading={busy}
                onClick={() => void startPreview()}
                variant="primary"
              >
                {t["com.myoxus.workspace-content-operation.action.continue"]()}
              </Button>
            ) : null}
            {stage === "review" && preview ? (
              <Button
                disabled={
                  busy ||
                  preview.blockers.length > 0 ||
                  preview.requiredConfirmations.some(
                    (confirmation) =>
                      !confirmed.has(confirmationKey(confirmation)),
                  )
                }
                loading={busy}
                onClick={() => void execute()}
                variant="primary"
              >
                {t["com.myoxus.workspace-content-operation.action.confirm"]()}
              </Button>
            ) : null}
            {stage === "progress" &&
            operation &&
            (operation.status === WorkspaceContentOperationStatusType.Queued ||
              operation.status ===
                WorkspaceContentOperationStatusType.Running) ? (
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => void cancel()}
                variant="secondary"
              >
                {t["com.myoxus.workspace-content-operation.action.cancel"]()}
              </Button>
            ) : null}
            {stage === "progress" &&
            operation?.status === WorkspaceContentOperationStatusType.Failed &&
            operation.kind !==
              WorkspaceContentOperationKindType.ExtractFolder &&
            operation.errorCode !==
              WorkspaceContentErrorCodeType.XWS_PREFLIGHT_STALE ? (
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => void retry()}
                variant="primary"
              >
                {t["Retry"]()}
              </Button>
            ) : null}
            {stage === "progress" &&
            operation?.status === WorkspaceContentOperationStatusType.Failed &&
            (operation.kind ===
              WorkspaceContentOperationKindType.ExtractFolder ||
              operation.errorCode ===
                WorkspaceContentErrorCodeType.XWS_PREFLIGHT_STALE) &&
            (selection || operation.originOperationId) ? (
              <Button disabled={busy} onClick={reviewAgain} variant="primary">
                {t[
                  "com.myoxus.workspace-content-operation.action.review-again"
                ]()}
              </Button>
            ) : null}
            {stage === "progress" &&
            operation?.status ===
              WorkspaceContentOperationStatusType.Succeeded &&
            operation.gitSyncPending ? (
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => void retry()}
                variant="secondary"
              >
                {t["Retry"]()}
              </Button>
            ) : null}
            {stage === "progress" &&
            operation?.status ===
              WorkspaceContentOperationStatusType.Succeeded &&
            (operation.kind === WorkspaceContentOperationKindType.Move ||
              operation.kind ===
                WorkspaceContentOperationKindType.ExtractFolder) ? (
              <Button
                disabled={busy || operation.gitSyncPending}
                loading={busy}
                onClick={() => void prepareUndo(operation.id)}
                variant="secondary"
              >
                {t["Undo"]()}
              </Button>
            ) : null}
            {stage === "progress" &&
            operation?.status ===
              WorkspaceContentOperationStatusType.Succeeded &&
            !operation.originOperationId &&
            (isExtract ||
              (kind === WorkspaceContentOperationKindType.Move &&
                selection?.type === "resources" &&
                selection.resources.length === 1)) ? (
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => void openTarget()}
                prefix={<OpenInNewIcon />}
                variant="primary"
              >
                {isExtract
                  ? t["com.myoxus.workspace-import.open"]()
                  : t[
                      "com.myoxus.workspace-content-operation.action.open-target"
                    ]()}
              </Button>
            ) : null}
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function TargetStage({
  extractName,
  isExtract,
  gitConfigured,
  gitSyncChoice,
  onGitChoiceChange,
  isLink,
  linkFolderData,
  linkFolderId,
  loading,
  onExtractNameChange,
  onLinkFolderChange,
  onTargetChange,
  targetData,
  targetWorkspaceId,
}: {
  extractName: string;
  isExtract: boolean;
  gitConfigured: boolean;
  gitSyncChoice: WorkspaceContentGitSyncChoiceType;
  onGitChoiceChange: (value: WorkspaceContentGitSyncChoiceType) => void;
  isLink: boolean;
  linkFolderData: Array<{ value: string; label: string }>;
  linkFolderId: string;
  loading: boolean;
  onExtractNameChange: (value: string) => void;
  onLinkFolderChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  targetData: Array<{ value: string; label: string }>;
  targetWorkspaceId: string;
}) {
  const t = useI18n();
  if (loading && targetData.length === 0) {
    return <Loading />;
  }
  return (
    <Stack>
      {isExtract ? (
        <MyoxusTextInput
          autoFocus
          block
          disabled={loading}
          label={t[
            "com.myoxus.workspace-content-operation.extract.name-label"
          ]()}
          onChange={onExtractNameChange}
          value={extractName}
        />
      ) : targetData.length > 0 ? (
        <Select
          block
          data={targetData}
          label={t["com.myoxus.workspace-content-operation.target.label"]()}
          onChange={onTargetChange}
          placeholder={t[
            "com.myoxus.workspace-content-operation.target.placeholder"
          ]()}
          value={targetWorkspaceId}
        />
      ) : (
        <SettingsNotice tone="warning">
          {t["com.myoxus.workspace-content-operation.target.none-available"]()}
        </SettingsNotice>
      )}
      {isExtract && gitConfigured ? (
        <>
          <Select
            block
            disabled={loading}
            label={t["com.myoxus.integration.git-sync.name"]()}
            value={gitSyncChoice}
            data={[
              {
                value: WorkspaceContentGitSyncChoiceType.Move,
                label: t["com.myoxus.workspace-content-operation.git.move"](),
              },
              {
                value: WorkspaceContentGitSyncChoiceType.Disconnect,
                label:
                  t["com.myoxus.workspace-content-operation.git.disconnect"](),
              },
            ]}
            onChange={(value) => {
              if (
                value === WorkspaceContentGitSyncChoiceType.Move ||
                value === WorkspaceContentGitSyncChoiceType.Disconnect
              )
                onGitChoiceChange(value);
            }}
          />
          <MyoxusText>
            {gitSyncChoice === WorkspaceContentGitSyncChoiceType.Move
              ? t["com.myoxus.workspace-content-operation.git.move-detail"]()
              : t[
                  "com.myoxus.workspace-content-operation.git.disconnect-detail"
                ]()}
          </MyoxusText>
        </>
      ) : null}
      {isLink && targetWorkspaceId ? (
        linkFolderData.length > 0 ? (
          <Select
            block
            data={linkFolderData}
            label={t[
              "com.myoxus.workspace-content-operation.target.folder-label"
            ]()}
            onChange={onLinkFolderChange}
            value={linkFolderId}
          />
        ) : loading ? (
          <Loading />
        ) : (
          <SettingsNotice tone="warning">
            {t["com.myoxus.workspace-content-operation.target.no-folder"]()}
          </SettingsNotice>
        )
      ) : null}
    </Stack>
  );
}

function ReviewStage({
  confirmed,
  kind,
  onConfirmedChange,
  preview,
}: {
  confirmed: Set<string>;
  kind: WorkspaceContentOperationKindType;
  onConfirmedChange: (value: Set<string>) => void;
  preview: WorkspaceContentPreflightProjectionFragment;
}) {
  const t = useI18n();
  return (
    <Stack>
      <Group wrap="wrap">
        {preview.resourceCounts.map((item) => (
          <Badge key={item.kind} tone="neutral">
            {resourceLabel(t, item.kind, item.count)}
          </Badge>
        ))}
      </Group>
      {preview.gitSync ? (
        <>
          <SettingsNotice tone="info">
            {preview.gitSync.isUndo
              ? t["com.myoxus.workspace-content-operation.git.undo-detail"]()
              : preview.gitSync.choice ===
                  WorkspaceContentGitSyncChoiceType.Move
                ? t["com.myoxus.workspace-content-operation.git.move-detail"]()
                : t[
                    "com.myoxus.workspace-content-operation.git.disconnect-detail"
                  ]()}
          </SettingsNotice>
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={t["com.myoxus.integration.git-sync.field.repo-url"]()}
              mono
            >
              {preview.gitSync.repository}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={t["com.myoxus.integration.git-sync.field.branch"]()}
              mono
            >
              {preview.gitSync.branch}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={t["com.myoxus.integration.git-sync.field.root-path"]()}
              mono
            >
              {preview.gitSync.newRoot}
            </SettingsDefinitionItem>
            {preview.gitSync.choice ===
            WorkspaceContentGitSyncChoiceType.Move ? (
              <SettingsDefinitionItem
                label={t[
                  "com.myoxus.integration.git-sync.field.manifest-path"
                ]()}
                mono
              >
                {preview.gitSync.ownManifest}
              </SettingsDefinitionItem>
            ) : null}
          </SettingsDefinitionList>
        </>
      ) : null}
      {kind === WorkspaceContentOperationKindType.Move ||
      kind === WorkspaceContentOperationKindType.Copy ? (
        <SettingsNotice tone="info">
          {t["com.myoxus.workspace-content-operation.review.access-scope"]()}
        </SettingsNotice>
      ) : null}
      {preview.blockers.map((blocker) => (
        <SettingsNotice key={blocker} tone="error" role="alert">
          {blockerLabel(t, blocker)}
        </SettingsNotice>
      ))}
      {preview.missingResources.map((resource) => (
        <MyoxusText
          key={`${resource.workspaceId}:${resource.kind}:${resource.id}`}
        >
          {t["com.myoxus.workspace-content-operation.review.missing-resource"]({
            kind: resourceKindLabel(t, resource.kind),
            id: resource.id,
          })}
        </MyoxusText>
      ))}
      {preview.conflicts.map((conflict) => (
        <SettingsNotice
          key={`${conflict.kind}:${conflict.resource.id}`}
          tone="warning"
        >
          {t["com.myoxus.workspace-content-operation.review.conflict"]({
            kind: conflictLabel(t, conflict.kind),
          })}
        </SettingsNotice>
      ))}
      {preview.membershipImpacts.length > 0 ? (
        <SettingsNotice
          title={t["com.myoxus.workspace-content-operation.review.memberships"](
            {
              count: preview.membershipImpactCount.toString(),
            },
          )}
          tone="warning"
        >
          <Stack gap="xs">
            {preview.membershipImpacts.map((impact) => (
              <MyoxusText
                key={`${impact.userId}:${impact.requiredRole}`}
                tone="secondary"
                typographySlot="body-small"
              >
                {t[
                  "com.myoxus.workspace-content-operation.review.membership-role"
                ]({ role: roleLabel(t, impact.requiredRole) })}
              </MyoxusText>
            ))}
          </Stack>
        </SettingsNotice>
      ) : null}
      {preview.requiredConfirmations.map((confirmation) => {
        const key = confirmationKey(confirmation);
        return (
          <Checkbox
            checked={confirmed.has(key)}
            key={key}
            label={confirmationLabel(t, confirmation.kind)}
            onChange={(_, checked) => {
              const next = new Set(confirmed);
              if (checked) next.add(key);
              else next.delete(key);
              onConfirmedChange(next);
            }}
          />
        );
      })}
      {preview.blockers.length === 0 &&
      preview.requiredConfirmations.length === 0 ? (
        <SettingsNotice
          title={t["com.myoxus.workspace-content-operation.review.ready"]()}
          tone="success"
        >
          {t["com.myoxus.workspace-content-operation.review.ready-detail"]({
            count: preview.resourceCount.toString(),
          })}
        </SettingsNotice>
      ) : null}
    </Stack>
  );
}

function ProgressStage({
  operation,
}: {
  operation: WorkspaceContentOperationProjectionFragment;
}) {
  const t = useI18n();
  if (operation.gitSyncPending)
    return <GitContentPendingNotice operation={operation} />;
  const running =
    operation.status === WorkspaceContentOperationStatusType.Queued ||
    operation.status === WorkspaceContentOperationStatusType.Running;
  const tone =
    operation.status === WorkspaceContentOperationStatusType.Succeeded
      ? "success"
      : operation.status === WorkspaceContentOperationStatusType.Failed ||
          operation.status ===
            WorkspaceContentOperationStatusType.CleanupRequired
        ? "error"
        : operation.status === WorkspaceContentOperationStatusType.Cancelled
          ? "neutral"
          : "info";
  return (
    <Stack>
      {running ? <Loading /> : null}
      <SettingsNotice title={statusLabel(t, operation.status)} tone={tone}>
        <Stack>
          {operation.errorCode ||
          operation.status === WorkspaceContentOperationStatusType.Failed ? (
            <MyoxusText>{failureDetail(t, operation)}</MyoxusText>
          ) : null}
          {operation.errorPhase ? (
            <MyoxusText>
              {t["com.myoxus.workspace-content-operation.error.phase"]({
                phase: operation.errorPhase,
              })}
            </MyoxusText>
          ) : null}
          {operation.status ===
          WorkspaceContentOperationStatusType.CleanupRequired ? (
            <MyoxusText>
              {t[
                "com.myoxus.workspace-content-operation.status.cleanup-detail"
              ]()}
            </MyoxusText>
          ) : running ? (
            <MyoxusText>
              {t[
                "com.myoxus.workspace-content-operation.status.running-detail"
              ]()}
            </MyoxusText>
          ) : null}
          <MyoxusText>
            {t["com.myoxus.workspace-content-operation.error.operation-id"]({
              id: operation.id,
            })}
          </MyoxusText>
        </Stack>
      </SettingsNotice>
    </Stack>
  );
}

function failureDetail(
  t: ReturnType<typeof useI18n>,
  operation: WorkspaceContentOperationProjectionFragment,
) {
  const diagnosticKey = workspaceContentFailureKey(
    operation.errorMessage,
    operation.errorCode,
  );
  if (diagnosticKey) return t[diagnosticKey]();
  switch (operation.errorCode) {
    case WorkspaceContentErrorCodeType.XWS_PREFLIGHT_STALE:
      return t["com.myoxus.workspace-content-operation.error.preview-stale"]();
    case WorkspaceContentErrorCodeType.XWS_WORKSPACE_NAME_CONFLICT:
      return t[
        "com.myoxus.workspace-content-operation.blocker.workspace-name"
      ]();
    case WorkspaceContentErrorCodeType.XWS_OWNERSHIP_UNSUPPORTED:
      return t[
        "com.myoxus.workspace-content-operation.blocker.ownership-unsupported"
      ]();
    default:
      return operation.kind === WorkspaceContentOperationKindType.ExtractFolder
        ? t[
            "com.myoxus.workspace-content-operation.status.extract-failed-detail"
          ]()
        : t["com.myoxus.workspace-content-operation.status.failed-detail"]();
  }
}

function operationTitle(
  t: ReturnType<typeof useI18n>,
  kind: WorkspaceContentOperationKindType,
) {
  switch (kind) {
    case WorkspaceContentOperationKindType.Move:
      return t["com.myoxus.workspace-content-operation.title.move"]();
    case WorkspaceContentOperationKindType.Copy:
      return t["com.myoxus.workspace-content-operation.title.copy"]();
    case WorkspaceContentOperationKindType.Link:
      return t["com.myoxus.workspace-content-operation.title.link"]();
    case WorkspaceContentOperationKindType.ExtractFolder:
      return t["com.myoxus.workspace-content-operation.title.extract"]();
  }
}

function resourceLabel(
  t: ReturnType<typeof useI18n>,
  kind: WorkspaceContentResourceKindType,
  count: number,
) {
  return t["com.myoxus.workspace-content-operation.review.resource-count"]({
    count: count.toString(),
    kind: resourceKindLabel(t, kind),
  });
}

function resourceKindLabel(
  t: ReturnType<typeof useI18n>,
  kind: WorkspaceContentResourceKindType,
) {
  switch (kind) {
    case "Document":
      return t["com.myoxus.workspace-content-operation.kind.document"]();
    case "Database":
      return t["com.myoxus.workspace-content-operation.kind.database"]();
    case "Collection":
      return t["com.myoxus.workspace-content-operation.kind.collection"]();
    case "Folder":
      return t["com.myoxus.workspace-content-operation.kind.folder"]();
    case "Tag":
      return t["com.myoxus.workspace-content-operation.kind.tag"]();
    case "Blob":
      return t["com.myoxus.workspace-content-operation.kind.file"]();
    default:
      return t["com.myoxus.workspace-content-operation.kind.unknown"]();
  }
}

function blockerLabel(
  t: ReturnType<typeof useI18n>,
  blocker: WorkspaceContentBlockerType,
) {
  switch (blocker) {
    case "GitSyncScopeAmbiguous":
      return t["com.myoxus.workspace-content-operation.git.ambiguous"]();
    case "GitSyncOwnershipUnproven":
      return t["com.myoxus.workspace-content-operation.git.unproven"]();
    case "GitSyncBusy":
      return t["com.myoxus.workspace-content-operation.git.busy"]();
    case "GitSyncManagementDenied":
      return t["com.myoxus.workspace-content-operation.git.permission"]();
    case "GitSyncConflicts":
      return t["com.myoxus.workspace-content-operation.git.conflicts"]();
    case "GitSyncHandoffUnavailable":
      return t["com.myoxus.workspace-content-operation.git.unavailable"]();
    case "BrokenReference":
      return t[
        "com.myoxus.workspace-content-operation.blocker.broken-reference"
      ]();
    case "ExternalDeployment":
      return t[
        "com.myoxus.workspace-content-operation.blocker.external-deployment"
      ]();
    case "MembershipPermission":
      return t[
        "com.myoxus.workspace-content-operation.blocker.membership-permission"
      ]();
    case "OwnershipUnsupported":
      return t[
        "com.myoxus.workspace-content-operation.blocker.ownership-unsupported"
      ]();
    case "PermissionDenied":
      return t[
        "com.myoxus.workspace-content-operation.blocker.permission-denied"
      ]();
    case "PublicShareConflict":
      return t["com.myoxus.workspace-content-operation.blocker.public-share"]();
    case "TargetPolicy":
      return t[
        "com.myoxus.workspace-content-operation.blocker.target-policy"
      ]();
    case "WorkspaceNameConflict":
      return t[
        "com.myoxus.workspace-content-operation.blocker.workspace-name"
      ]();
    default:
      return t["com.myoxus.workspace-content-operation.blocker.unknown"]();
  }
}

function confirmationLabel(
  t: ReturnType<typeof useI18n>,
  kind: WorkspaceContentConfirmationKindType,
) {
  switch (kind) {
    case "AddTargetMember":
      return t[
        "com.myoxus.workspace-content-operation.confirmation.add-member"
      ]();
    case "CopyDocumentAcl":
      return t[
        "com.myoxus.workspace-content-operation.confirmation.copy-access"
      ]();
    case "DisablePublicShare":
      return t[
        "com.myoxus.workspace-content-operation.confirmation.disable-public"
      ]();
    default:
      return t["com.myoxus.workspace-content-operation.confirmation.unknown"]();
  }
}

function statusLabel(
  t: ReturnType<typeof useI18n>,
  status: WorkspaceContentOperationStatusType,
) {
  switch (status) {
    case "Draft":
      return t["com.myoxus.workspace-content-operation.status.draft"]();
    case "Previewed":
      return t["com.myoxus.workspace-content-operation.status.previewed"]();
    case "Queued":
      return t["com.myoxus.workspace-content-operation.status.queued"]();
    case "Running":
      return t["com.myoxus.common.status.in-progress"]();
    case "Succeeded":
      return t["com.myoxus.common.status.completed"]();
    case "Failed":
      return t["com.myoxus.workspace-content-operation.status.failed"]();
    case "Cancelled":
      return t["com.myoxus.workspace-content-operation.status.cancelled"]();
    case "CleanupRequired":
      return t[
        "com.myoxus.workspace-content-operation.status.cleanup-required"
      ]();
    default:
      return t["com.myoxus.workspace-content-operation.status.unknown"]();
  }
}

function conflictLabel(
  t: ReturnType<typeof useI18n>,
  kind: WorkspaceContentConflictKindType,
) {
  switch (kind) {
    case "Key":
      return t["com.myoxus.workspace-content-operation.conflict.key"]();
    case "PublicSharing":
      return t["com.myoxus.workspace-content-operation.conflict.public"]();
    case "Schema":
      return t["com.myoxus.workspace-content-operation.conflict.schema"]();
    default:
      return t["com.myoxus.workspace-content-operation.conflict.unknown"]();
  }
}

function roleLabel(t: ReturnType<typeof useI18n>, role: Permission) {
  switch (role) {
    case "Owner":
      return t["com.myoxus.workspace-content-operation.role.owner"]();
    case "Admin":
      return t["com.myoxus.workspace-content-operation.role.admin"]();
    case "Manager":
      return t["com.myoxus.workspace-content-operation.role.manager"]();
    case "Collaborator":
      return t["com.myoxus.workspace-content-operation.role.collaborator"]();
    case "Commenter":
      return t["com.myoxus.workspace-content-operation.role.commenter"]();
    case "Reader":
      return t["com.myoxus.workspace-content-operation.role.reader"]();
    case "External":
      return t["com.myoxus.workspace-content-operation.role.external"]();
    default:
      return t["com.myoxus.workspace-content-operation.role.unknown"]();
  }
}
