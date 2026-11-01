// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  AssistantContext,
  AssistantControlKind,
  AssistantNativeActionKind,
  prepareTaskPreparationQuery,
  taskPreparationQuery,
  configureTaskPreparationMutation,
  taskPreparationRunQuery,
  retryTaskPreparationRunMutation,
  stopTaskPreparationRunMutation,
  type TaskPreparationRunFragmentFragment,
  prepareTaskMaintenanceRuleQuery,
  taskMaintenanceRuleQuery,
  configureTaskMaintenanceMutation,
  type AssistantPackageFragmentFragment,
  type PreparedTaskPreparationFragmentFragment,
  type PreparedTaskMaintenanceFragmentFragment,
  type TaskPreparationConfigurationFragmentFragment,
  type ConfigureTaskPreparationInput,
  createWorkspaceAutomationMutation,
  databaseAutomationsQuery,
  disableWorkspaceAutomationMutation,
  type WorkspaceAutomationFragment,
  type WorkspaceAutomationRunFragment,
  WorkspaceAutomationRunStatus,
  WorkspaceAutomationRunOrigin,
  WorkspaceAutomationStatus,
  WorkspaceAutomationTriggerKind,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon, PlusIcon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  EmptyState,
  EmptyStateTitle,
  FormRow,
  Group,
  Input,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  notify,
  Stack,
  Textarea,
  TimelineList,
  TimelineListItem,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useFramework, useService } from "@myoxus/infra";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { TaskRowReference } from "../database-block-adapter/task-row-reference";
import { GlobalState } from "@myoxus/core/modules/storage";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { SavedSetupControls } from "../presentation/saved-setup-controls";
import {
  useSavedSetup,
  savedSetupAnswers,
  savedSetupDescriptor,
} from "../presentation/use-saved-setup";
import { useAssistantPackage } from "../presentation/use-assistant-package";
import { AssistantGroups } from "../presentation/renderer";
import {
  assistantText,
  assistantAnswerPayload,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "../presentation/values";
import { useAssistantFormValidation } from "../presentation/use-form-validation";
import {
  readConfirmedAssistantAttempt,
  saveConfirmedAssistantAttempt,
} from "../assistance/context-documents-attempt";
import { useOpenMaintenanceRun } from "../assistance/context";
import { nativeTaskAnswersFromTransport } from "../assistance/document-review";
import { TaskMaintenancePlan } from "../assistance/task-maintenance";
import { TEMPLATE_SUGGESTION_CLIENT_VERSION } from "@myoxus/core/modules/template-doc/services/template-doc";

type I18nShape = ReturnType<typeof useI18n>;

const DATABASE_AUTOMATION_QUERY_CONFIG = {
  suspense: false,
  suppressErrorNotification: true,
} as const;

function formatAutomationDate(
  language: string | undefined,
  value: string | null | undefined,
) {
  if (!value) return "";
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function workspaceAutomationStatusLabel(
  t: I18nShape,
  status: WorkspaceAutomationStatus,
) {
  switch (status) {
    case WorkspaceAutomationStatus.Enabled:
      return t["com.myoxus.database.automation.status.enabled"]();
    case WorkspaceAutomationStatus.Disabled:
      return t["com.myoxus.database.automation.status.disabled"]();
    default:
      return status;
  }
}

export function workspaceAutomationRunStatusLabel(
  t: I18nShape,
  status: WorkspaceAutomationRunStatus,
) {
  switch (status) {
    case WorkspaceAutomationRunStatus.DeadLetter:
      return t["com.myoxus.database.automation.run.status.dead-letter"]();
    case WorkspaceAutomationRunStatus.Failed:
      return t["com.myoxus.database.automation.run.status.failed"]();
    case WorkspaceAutomationRunStatus.Queued:
      return t["com.myoxus.database.automation.run.status.queued"]();
    case WorkspaceAutomationRunStatus.Running:
      return t["com.myoxus.database.automation.run.status.running"]();
    case WorkspaceAutomationRunStatus.Skipped:
      return t["com.myoxus.database.automation.run.status.skipped"]();
    case WorkspaceAutomationRunStatus.Succeeded:
      return t["com.myoxus.database.automation.run.status.succeeded"]();
    default:
      return status;
  }
}

export function workspaceAutomationRunTone(
  status: WorkspaceAutomationRunStatus,
) {
  switch (status) {
    case WorkspaceAutomationRunStatus.Succeeded:
      return "success" as const;
    case WorkspaceAutomationRunStatus.DeadLetter:
    case WorkspaceAutomationRunStatus.Failed:
      return "error" as const;
    case WorkspaceAutomationRunStatus.Queued:
    case WorkspaceAutomationRunStatus.Running:
      return "info" as const;
    case WorkspaceAutomationRunStatus.Skipped:
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

function workspaceAutomationTriggerLabel(
  t: I18nShape,
  trigger: WorkspaceAutomationTriggerKind,
) {
  switch (trigger) {
    case WorkspaceAutomationTriggerKind.RelationChanged:
      return t["com.myoxus.database.automation.trigger.relation-changed"]();
    case WorkspaceAutomationTriggerKind.RowCreated:
      return t["com.myoxus.database.automation.trigger.row-created"]();
    case WorkspaceAutomationTriggerKind.RowUpdated:
      return t["com.myoxus.database.automation.trigger.row-updated"]();
    case WorkspaceAutomationTriggerKind.StatusSelectChanged:
      return t[
        "com.myoxus.database.automation.trigger.status-select-changed"
      ]();
    default:
      return trigger;
  }
}

function DatabaseAutomationRuns({
  runs,
  maintenanceRuleId,
  onOpenMaintenanceRun,
  preparationRuleId,
  onOpenPreparationRun,
}: {
  runs: WorkspaceAutomationRunFragment[];
  maintenanceRuleId?: string | null;
  onOpenMaintenanceRun?: (runId: string, opener?: HTMLElement | null) => void;
  preparationRuleId?: string;
  onOpenPreparationRun?: (runId: string, opener?: HTMLElement | null) => void;
}) {
  const t = useI18n();
  if (!runs.length) {
    return (
      <EmptyState
        title={t["com.myoxus.database.automation.runs-empty-title"]()}
        description={t[
          "com.myoxus.database.automation.runs-empty-description"
        ]()}
        data-testid="database-automation-runs-empty"
      />
    );
  }

  return (
    <TimelineList
      aria-label={t["com.myoxus.database.automation.runs-title"]()}
      data-testid="database-automation-runs"
    >
      {runs.map((run) => (
        <TimelineListItem
          key={run.id}
          data-testid="database-automation-run"
          title={
            <Group gap="xs" wrap="wrap">
              <Badge tone={workspaceAutomationRunTone(run.status)}>
                {run.deadLetter
                  ? t["com.myoxus.database.automation.run.status.dead-letter"]()
                  : workspaceAutomationRunStatusLabel(t, run.status)}
              </Badge>
              <MyoxusText
                component="span"
                tone="secondary"
                typographySlot="body-small"
              >
                {formatAutomationDate(t.language, run.queuedAt)}
              </MyoxusText>
            </Group>
          }
        >
          <MyoxusText tone="secondary" typographySlot="body-small">
            {t["com.myoxus.database.automation.run.attempts"]()}:{" "}
            {run.attemptCount}
          </MyoxusText>
          {maintenanceRuleId &&
          run.automationId === maintenanceRuleId &&
          onOpenMaintenanceRun ? (
            <Button
              onClick={(event) =>
                onOpenMaintenanceRun(run.id, event.currentTarget)
              }
            >
              {t["com.myoxus.database.setup.check"]()}
            </Button>
          ) : null}
          {preparationRuleId &&
          run.automationId === preparationRuleId &&
          onOpenPreparationRun ? (
            <Button
              onClick={(event) =>
                onOpenPreparationRun(run.id, event.currentTarget)
              }
            >
              {t["com.myoxus.database.setup.check"]()}
            </Button>
          ) : null}
          {run.errorCode ? (
            <MyoxusText tone="secondary" typographySlot="body-small">
              {`${run.errorCode}: ${run.errorMessage ?? ""}`.trim()}
            </MyoxusText>
          ) : null}
        </TimelineListItem>
      ))}
    </TimelineList>
  );
}

/** Server-backed Database automation management for the Workbench context. */
export function DatabaseAutomationsPanel({
  canEdit,
  canUseTaskAssistance,
  databaseId,
  workspaceId,
}: {
  canEdit: boolean;
  canUseTaskAssistance: boolean;
  databaseId: string;
  workspaceId: string;
}) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const storage = useService(GlobalState);
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const [preparationRunId, setPreparationRunId] = useState<string>();
  const [preparationRun, setPreparationRun] =
    useState<TaskPreparationRunFragmentFragment>();
  const preparationRunTrigger = useRef<HTMLElement | null>(null);
  const openMaintenanceRun = useOpenMaintenanceRun();
  const [knownMaintenanceRuleId, setKnownMaintenanceRuleId] = useState<
    string | null
  >();
  const [ownMaintenanceRule, setOwnMaintenanceRule] =
    useState<TaskPreparationConfigurationFragmentFragment | null>();
  const [ownPreparationRule, setOwnPreparationRule] =
    useState<TaskPreparationConfigurationFragmentFragment | null>();
  const [ruleDiscoveryFailed, setRuleDiscoveryFailed] = useState(false);
  const [ruleDiscoveryRevision, setRuleDiscoveryRevision] = useState(0);
  const packages = useAssistantPackage(
    AssistantContext.TaskContainerAssistance,
    canUseTaskAssistance,
  );
  const personalSources =
    !canUseTaskAssistance ||
    packages.error ||
    packages.data?.workspace?.id !== workspaceId
      ? []
      : (packages.data?.workspace?.assistantPackages.filter((source) =>
          source.components.some(
            (component) =>
              component.action.kind ===
                AssistantNativeActionKind.ConfigureTaskPreparation ||
              component.action.kind ===
                AssistantNativeActionKind.TaskMaintenance,
          ),
        ) ?? []);
  const personalAvailable = personalSources.length > 0;
  const personalCatalogIdentity = JSON.stringify(
    personalSources.map((source) => source.identity),
  );
  const personalSourcesRef = useRef(personalSources);
  personalSourcesRef.current = personalSources;
  const [personalSource, setPersonalSource] =
    useState<AssistantPackageFragmentFragment>();
  const [personalAnswers, setPersonalAnswers] = useState<AssistantAnswers>({});
  const [personalPlan, setPersonalPlan] = useState<
    | PreparedTaskPreparationFragmentFragment
    | PreparedTaskMaintenanceFragmentFragment
  >();
  const [personalRule, setPersonalRule] =
    useState<TaskPreparationConfigurationFragmentFragment | null>();
  const personalReviewedRule = useRef<
    TaskPreparationConfigurationFragmentFragment | null | undefined
  >(undefined);
  const [confirmedConfig, setConfirmedConfig] =
    useState<ConfigureTaskPreparationInput>();
  const [personalFailed, setPersonalFailed] = useState(false);
  const [personalOperationBusy, setPersonalBusy] = useState(false);
  const [personalLoaded, setPersonalLoaded] = useState(false);
  const [personalEditing, setPersonalEditing] = useState(false);
  const saved = useSavedSetup(
    personalSource ? (owner.server ?? undefined) : undefined,
    AssistantContext.TaskContainerAssistance,
    personalOperationBusy ||
      !personalLoaded ||
      Boolean(confirmedConfig) ||
      personalEditing ||
      !personalAvailable ||
      owner.availability.status !== "available",
  );
  const personalBusy = personalOperationBusy || saved.busy;
  const personalFlight = useRef(false);
  const personalEpoch = useRef(0);
  const personalOwner = useRef(owner.identity);
  personalOwner.current = owner.identity;
  const personalValid = useRef(true);
  useEffect(() => {
    personalValid.current = Boolean(owner.identity);
    const subscription = owner.server?.account$.subscribe((account) => {
      if (account?.id !== owner.account?.id) {
        personalValid.current = false;
        ++personalEpoch.current;
        setPersonalBusy(false);
      }
    });
    return () => subscription?.unsubscribe();
  }, [owner.server, owner.account?.id, owner.identity]);
  useEffect(
    () => () => {
      ++personalEpoch.current;
    },
    [],
  );
  useEffect(() => {
    ++personalEpoch.current;
    setPersonalSource(undefined);
    setPersonalRule(undefined);
    setPersonalPlan(undefined);
    setConfirmedConfig(undefined);
    setPersonalEditing(false);
    setPersonalBusy(false);
    setPreparationRunId(undefined);
    setPreparationRun(undefined);
    personalReviewedRule.current = undefined;
  }, [
    owner.identity,
    workspaceId,
    databaseId,
    canUseTaskAssistance,
    personalCatalogIdentity,
  ]);
  useEffect(() => {
    let active = true;
    const identity = owner.identity;
    setKnownMaintenanceRuleId(undefined);
    setOwnMaintenanceRule(undefined);
    setOwnPreparationRule(undefined);
    setRuleDiscoveryFailed(false);
    if (
      !owner.server ||
      !identity ||
      owner.availability.status !== "available" ||
      owner.workspace.id !== workspaceId ||
      owner.server.account$.value?.id !== owner.account?.id
    )
      return;
    // Installed rules remain discoverable after their fresh offering is withdrawn.
    // Invalidate this read on account transitions even if React batches A→B→A.
    const subscription = owner.server.account$.subscribe((account) => {
      if (account?.id !== owner.account?.id) active = false;
    });
    void (async () => {
      const results = await Promise.allSettled([
        owner.server!.gql({
          query: taskMaintenanceRuleQuery,
          variables: { workspaceId, databaseId },
        }),
        owner.server!.gql({
          query: taskPreparationQuery,
          variables: { workspaceId, databaseId },
        }),
      ]);
      if (
        !active ||
        owner.server!.account$.value?.id !== owner.account?.id ||
        personalOwner.current !== identity
      )
        return;
      let failed = false;
      for (const result of results) {
        if (result.status === "rejected") {
          failed = true;
          continue;
        }
        const response = result.value;
        const rule =
          response.workspace &&
          ("taskMaintenanceRule" in response.workspace
            ? response.workspace.taskMaintenanceRule
            : response.workspace.taskPreparation);
        if (
          response.currentUser?.id !== owner.account?.id ||
          response.workspace?.id !== workspaceId ||
          (rule &&
            (rule.actorId !== owner.account?.id ||
              rule.databaseId !== databaseId ||
              rule.workspaceId !== workspaceId))
        ) {
          failed = true;
          continue;
        }
        if ("taskMaintenanceRule" in response.workspace) {
          setKnownMaintenanceRuleId(rule?.id ?? null);
          setOwnMaintenanceRule(rule ?? null);
        } else setOwnPreparationRule(rule ?? null);
      }
      setRuleDiscoveryFailed(failed);
    })();
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [
    owner.identity,
    owner.account?.id,
    owner.server,
    owner.availability.status,
    owner.workspace.id,
    workspaceId,
    databaseId,
    ruleDiscoveryRevision,
  ]);
  const maintenanceConfig =
    personalSource?.components.some(
      (component) =>
        component.action.kind === AssistantNativeActionKind.TaskMaintenance,
    ) ?? false;
  const configKey = `context-documents:configuration:${JSON.stringify([owner.server?.id, owner.account?.id, workspaceId, databaseId, maintenanceConfig ? "taskMaintenance" : "taskPreparation"])}`;
  const personalValidation = useAssistantFormValidation<HTMLDivElement>(
    personalSource,
    personalAnswers,
  );
  const confirmedDisplay = useMemo(() => {
    if (
      !confirmedConfig ||
      !personalSource ||
      confirmedConfig.identity.id !== personalSource.identity.id ||
      confirmedConfig.identity.version !== personalSource.identity.version ||
      confirmedConfig.identity.digest !== personalSource.identity.digest
    )
      return undefined;
    try {
      return nativeTaskAnswersFromTransport(
        personalSource,
        confirmedConfig.answers,
      );
    } catch {
      return undefined;
    }
  }, [confirmedConfig, personalSource]);
  const personalPreviewCurrent = useCallback(
    () => personalValid.current && personalOwner.current === owner.identity,
    [owner.identity],
  );
  const validateConfig = (input: ConfigureTaskPreparationInput) => {
    if (
      !input ||
      input.workspaceId !== workspaceId ||
      input.target.databaseId !== databaseId ||
      input.target.taskId != null ||
      (input.ruleId != null &&
        (typeof input.ruleId !== "string" || !input.ruleId)) ||
      (input.ruleId != null) !== (input.expectedExecutionRevision != null) ||
      !input.identity.id ||
      !input.identity.version ||
      !input.identity.digest ||
      !input.locale ||
      !Number.isSafeInteger(input.clientVersion) ||
      typeof input.enabled !== "boolean"
    )
      throw new Error("Invalid confirmed personal configuration");
  };
  // Only a natively read own rule can admit retained recovery without a fresh source.
  const knownPersonalRule = (
    rule: TaskPreparationConfigurationFragmentFragment | undefined,
  ) =>
    Boolean(
      rule &&
      rule.actorId === owner.account?.id &&
      rule.workspaceId === workspaceId &&
      rule.databaseId === databaseId &&
      (rule.id === ownMaintenanceRule?.id ||
        rule.id === ownPreparationRule?.id),
    );
  const personalCurrent = (
    epoch: number,
    identity: string | null | undefined,
    recoveryRule?: TaskPreparationConfigurationFragmentFragment,
  ) =>
    personalValid.current &&
    (recoveryRule
      ? knownPersonalRule(recoveryRule)
      : personalSourcesRef.current.length > 0) &&
    personalEpoch.current === epoch &&
    personalOwner.current === identity;
  const personalPreflight = (
    recoveryRule?: TaskPreparationConfigurationFragmentFragment,
  ) => {
    if (
      (recoveryRule
        ? !knownPersonalRule(recoveryRule)
        : !personalSourcesRef.current.length) ||
      (!recoveryRule &&
        personalSource &&
        !personalSourcesRef.current.some(
          (item) =>
            item.identity.id === personalSource.identity.id &&
            item.identity.version === personalSource.identity.version &&
            item.identity.digest === personalSource.identity.digest,
        )) ||
      !owner.identity ||
      !owner.account?.id ||
      personalOwner.current !== owner.identity ||
      owner.server?.account$.value?.id !== owner.account.id ||
      owner.availability.status !== "available"
    )
      return false;
    if (!personalValid.current) {
      // Only a new explicit user action can rearm a batched logout-and-return.
      // Keep every earlier asynchronous response behind the invalidated epoch.
      ++personalEpoch.current;
      personalValid.current = true;
    }
    return true;
  };
  const personalRun = async (
    action: (epoch: number, identity: typeof owner.identity) => Promise<void>,
    recoveryRule?: TaskPreparationConfigurationFragmentFragment,
  ) => {
    if (personalFlight.current || !personalPreflight(recoveryRule)) return;
    personalFlight.current = true;
    const epoch = personalEpoch.current,
      identity = owner.identity;
    setPersonalBusy(true);
    setPersonalFailed(false);
    try {
      await action(epoch, identity);
    } catch {
      if (personalCurrent(epoch, identity, recoveryRule))
        setPersonalFailed(true);
    } finally {
      personalFlight.current = false;
      if (personalCurrent(epoch, identity, recoveryRule))
        setPersonalBusy(false);
    }
  };
  const readPersonal = async (
    maintenance: boolean,
    epoch: number,
    identity: typeof owner.identity,
    recoveryRule?: TaskPreparationConfigurationFragmentFragment,
  ) => {
    const response = maintenance
      ? await owner.server!.gql({
          query: taskMaintenanceRuleQuery,
          variables: { workspaceId, databaseId },
        })
      : await owner.server!.gql({
          query: taskPreparationQuery,
          variables: { workspaceId, databaseId },
        });
    if (!personalCurrent(epoch, identity, recoveryRule)) return undefined;
    if (
      response.currentUser?.id !== owner.account?.id ||
      response.workspace?.id !== workspaceId
    ) {
      setPersonalRule(undefined);
      setPersonalLoaded(false);
      throw new Error("Personal configuration owner changed");
    }
    const rule =
      "taskMaintenanceRule" in response.workspace
        ? response.workspace.taskMaintenanceRule
        : response.workspace.taskPreparation;
    if (
      rule &&
      (rule.actorId !== owner.account?.id ||
        rule.workspaceId !== workspaceId ||
        rule.databaseId !== databaseId)
    )
      throw new Error("Personal rule owner changed");
    setPersonalRule(rule);
    if (maintenance) {
      setKnownMaintenanceRuleId(rule?.id ?? null);
      setOwnMaintenanceRule(rule);
    } else setOwnPreparationRule(rule);
    setPersonalLoaded(true);
    return rule;
  };
  const configMatches = (
    input: ConfigureTaskPreparationInput,
    rule: TaskPreparationConfigurationFragmentFragment | null,
  ) =>
    Boolean(
      rule &&
      (input.ruleId == null || rule.id === input.ruleId) &&
      rule.planDigest === input.planDigest &&
      rule.package.id === input.identity.id &&
      rule.package.version === input.identity.version &&
      rule.package.digest === input.identity.digest &&
      rule.locale === input.locale &&
      rule.clientVersion === input.clientVersion &&
      (rule.status === WorkspaceAutomationStatus.Enabled) === input.enabled &&
      JSON.stringify(
        assistantAnswerPayload(
          Object.fromEntries(
            rule.answers.map((answer) => [answer.input, answer.value]),
          ),
        ),
      ) === JSON.stringify(input.answers),
    );
  const openPersonal = (source: AssistantPackageFragmentFragment) => {
    if (
      personalFlight.current ||
      !personalPreflight() ||
      !personalSourcesRef.current.some(
        (item) =>
          item.identity.id === source.identity.id &&
          item.identity.version === source.identity.version &&
          item.identity.digest === source.identity.digest,
      )
    )
      return;
    const epoch = ++personalEpoch.current,
      identity = owner.identity;
    const maintenance = source.components.some(
      (component) =>
        component.action.kind === AssistantNativeActionKind.TaskMaintenance,
    );
    const key = `context-documents:configuration:${JSON.stringify([owner.server?.id, owner.account?.id, workspaceId, databaseId, maintenance ? "taskMaintenance" : "taskPreparation"])}`;
    setPreparationRunId(undefined);
    setPreparationRun(undefined);
    setPersonalEditing(false);
    setPersonalSource(source);
    setPersonalAnswers(visibleAssistantAnswers(source, {}, true));
    setPersonalPlan(undefined);
    setPersonalRule(undefined);
    setConfirmedConfig(undefined);
    setPersonalLoaded(false);
    personalValidation.reset();
    void personalRun(async () => {
      const pending =
        await readConfirmedAssistantAttempt<ConfigureTaskPreparationInput>(
          storage,
          key,
          validateConfig,
        );
      if (!personalCurrent(epoch, identity)) return;
      setConfirmedConfig(pending ?? undefined);
      const rule = await readPersonal(maintenance, epoch, identity);
      if (!personalCurrent(epoch, identity) || rule === undefined) return;
      if (pending && configMatches(pending, rule)) {
        await saveConfirmedAssistantAttempt(
          storage,
          key,
          undefined,
          validateConfig,
        );
        if (!personalCurrent(epoch, identity)) return;
        setConfirmedConfig(undefined);
      }
      if (
        rule &&
        rule.package.id === source.identity.id &&
        rule.package.version === source.identity.version &&
        rule.package.digest === source.identity.digest
      )
        setPersonalAnswers(
          Object.fromEntries(
            rule.answers.map((answer) => [answer.input, answer.value]),
          ),
        );
    });
  };
  const preparePersonal = () =>
    void personalRun(async (epoch, identity) => {
      if (
        !personalSource ||
        (confirmedConfig && !personalEditing) ||
        !personalLoaded ||
        !personalValidation.validate()
      )
        return;
      const input = {
        target: { databaseId },
        identity: personalSource.identity,
        answers: assistantAnswerPayload(
          visibleAssistantAnswers(personalSource, personalAnswers),
        ),
        locale: t.language,
        clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
      };
      const response = maintenanceConfig
        ? await owner.server!.gql({
            query: prepareTaskMaintenanceRuleQuery,
            variables: { workspaceId, input },
          })
        : await owner.server!.gql({
            query: prepareTaskPreparationQuery,
            variables: { workspaceId, input },
          });
      if (!personalCurrent(epoch, identity)) return;
      if (
        response.currentUser?.id !== owner.account?.id ||
        response.workspace?.id !== workspaceId
      )
        throw new Error("Personal review owner changed");
      const plan =
        "prepareTaskMaintenanceRule" in response.workspace
          ? response.workspace.prepareTaskMaintenanceRule
          : response.workspace.prepareTaskPreparation;
      if (
        plan.actorId !== owner.account?.id ||
        plan.workspaceId !== workspaceId ||
        plan.target.databaseId !== databaseId ||
        plan.target.taskId != null ||
        plan.package.id !== personalSource.identity.id ||
        plan.package.version !== personalSource.identity.version ||
        plan.package.digest !== personalSource.identity.digest
      )
        throw new Error("Personal review source changed");
      // Confirmation must retain the rule revision observed for this review,
      // not adopt a concurrent rule update from the later read-before-write.
      personalReviewedRule.current = personalRule;
      setPersonalPlan(plan);
    });
  const configurePersonal = (
    enabled: boolean,
    existingOwnRule?: TaskPreparationConfigurationFragmentFragment,
    selectedMaintenance = maintenanceConfig,
  ) => {
    const recoveryRule = !enabled ? existingOwnRule : undefined;
    void personalRun(async (epoch, identity) => {
      if ((!personalSource || !personalLoaded) && !existingOwnRule) return;
      const selectedKey = `context-documents:configuration:${JSON.stringify([owner.server?.id, owner.account?.id, workspaceId, databaseId, selectedMaintenance ? "taskMaintenance" : "taskPreparation"])}`;
      const latest = await readPersonal(
        selectedMaintenance,
        epoch,
        identity,
        recoveryRule,
      );
      if (
        !personalCurrent(epoch, identity, recoveryRule) ||
        latest === undefined
      )
        return;
      if (existingOwnRule && latest?.id !== existingOwnRule.id)
        throw new Error("Personal rule identity changed");
      let input =
        existingOwnRule || personalEditing ? undefined : confirmedConfig;
      if (input && configMatches(input, latest)) {
        await saveConfirmedAssistantAttempt(
          storage,
          selectedKey,
          undefined,
          validateConfig,
        );
        if (personalCurrent(epoch, identity, recoveryRule))
          setConfirmedConfig(undefined);
        return;
      }
      if (!input) {
        const observed =
          existingOwnRule ??
          (enabled ? personalReviewedRule.current : personalRule);
        if (observed === undefined) return;
        if (
          (latest?.id ?? null) !== (observed?.id ?? null) ||
          (latest?.executionRevision ?? null) !==
            (observed?.executionRevision ?? null)
        ) {
          setPersonalPlan(undefined);
          personalReviewedRule.current = undefined;
          throw new Error("Personal configuration changed since review");
        }
        if (
          (enabled && !personalPlan?.executionAvailable) ||
          (!enabled && !latest)
        )
          return;
        const facts = enabled ? personalPlan : latest;
        if (!facts) return;
        input = {
          workspaceId,
          target: { databaseId },
          ruleId: observed?.id,
          expectedExecutionRevision: observed?.executionRevision,
          identity: facts.package,
          answers: assistantAnswerPayload(
            Object.fromEntries(
              facts.answers.map((answer) => [answer.input, answer.value]),
            ),
          ),
          locale: facts.locale,
          clientVersion: facts.clientVersion,
          planDigest: facts.planDigest,
          enabled,
        };
      }
      // Only confirmed transport survives reload. Native rule readback owns ACK.
      await saveConfirmedAssistantAttempt(
        storage,
        selectedKey,
        input,
        validateConfig,
      );
      if (!personalCurrent(epoch, identity, recoveryRule)) return;
      setConfirmedConfig(input);
      setPersonalEditing(false);
      const response = selectedMaintenance
        ? await owner.server!.gql({
            query: configureTaskMaintenanceMutation,
            variables: { input },
          })
        : await owner.server!.gql({
            query: configureTaskPreparationMutation,
            variables: { input },
          });
      if (!personalCurrent(epoch, identity, recoveryRule)) return;
      const rule =
        "configureTaskMaintenance" in response
          ? response.configureTaskMaintenance
          : response.configureTaskPreparation;
      if (
        rule.actorId !== owner.account?.id ||
        rule.workspaceId !== workspaceId ||
        rule.databaseId !== databaseId ||
        !configMatches(input, rule)
      )
        throw new Error("Personal configuration acknowledgement changed");
      setPersonalRule(rule);
      if (selectedMaintenance) {
        setKnownMaintenanceRuleId(rule.id);
        setOwnMaintenanceRule(rule);
      } else setOwnPreparationRule(rule);
      await saveConfirmedAssistantAttempt(
        storage,
        selectedKey,
        undefined,
        validateConfig,
      );
      if (!personalCurrent(epoch, identity, recoveryRule)) return;
      setConfirmedConfig(undefined);
      setPersonalPlan(undefined);
      await refresh();
    }, recoveryRule);
  };
  const readPreparationRun = async (
    runId: string,
    ruleId: string,
    epoch: number,
    identity: typeof owner.identity,
  ) => {
    const response = await owner
      .server!.gql({
        query: taskPreparationRunQuery,
        variables: { workspaceId, runId },
      })
      .catch((error) => {
        if (personalCurrent(epoch, identity, ownPreparationRule ?? undefined))
          setPreparationRun(undefined);
        throw error;
      });
    if (!personalCurrent(epoch, identity, ownPreparationRule ?? undefined))
      return undefined;
    const view = response.workspace?.taskPreparationRun;
    if (
      response.currentUser?.id !== owner.account?.id ||
      response.workspace?.id !== workspaceId ||
      !view ||
      view.run.id !== runId ||
      view.run.workspaceId !== workspaceId ||
      view.run.origin !== WorkspaceAutomationRunOrigin.Rule ||
      view.run.automationId !== ruleId
    ) {
      setPreparationRun(undefined);
      throw new Error("Personal preparation Run unavailable");
    }
    setPreparationRun(view);
    return view;
  };
  const openPreparationRun = (runId: string, opener?: HTMLElement | null) => {
    if (
      !ownPreparationRule ||
      personalFlight.current ||
      !personalPreflight(ownPreparationRule)
    )
      return;
    ++personalEpoch.current;
    preparationRunTrigger.current = opener ?? null;
    setPersonalSource(undefined);
    setPreparationRun(undefined);
    setPreparationRunId(runId);
    void personalRun(async (epoch, identity) => {
      await readPreparationRun(runId, ownPreparationRule.id, epoch, identity);
    }, ownPreparationRule);
  };
  const controlPreparationRun = (action?: "retry" | "stop") =>
    void personalRun(async (epoch, identity) => {
      if (!preparationRunId || !ownPreparationRule) return;
      // Read the same native Run before every control and after a lost response.
      // Neither retry nor Stop creates another preparation or result identity.
      const latest = await readPreparationRun(
        preparationRunId,
        ownPreparationRule.id,
        epoch,
        identity,
      );
      if (!latest || !action) return;
      if (action === "retry" ? !latest.canRetry : !latest.canStop) return;
      try {
        if (action === "retry")
          await owner.server!.gql({
            query: retryTaskPreparationRunMutation,
            variables: { runId: latest.run.id },
          });
        else
          await owner.server!.gql({
            query: stopTaskPreparationRunMutation,
            variables: { runId: latest.run.id },
          });
      } catch (error) {
        if (!personalCurrent(epoch, identity, ownPreparationRule ?? undefined))
          return;
        await readPreparationRun(
          latest.run.id,
          ownPreparationRule.id,
          epoch,
          identity,
        );
        throw error;
      }
      if (!personalCurrent(epoch, identity, ownPreparationRule ?? undefined))
        return;
      await readPreparationRun(
        latest.run.id,
        ownPreparationRule.id,
        epoch,
        identity,
      );
      await refresh();
    }, ownPreparationRule ?? undefined);
  const revalidate = useMutateQueryResource();
  const createAutomation = useMutation({
    mutation: createWorkspaceAutomationMutation,
  });
  const disableAutomation = useMutation({
    mutation: disableWorkspaceAutomationMutation,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [automationName, setAutomationName] = useState("");
  const [automationDescription, setAutomationDescription] = useState("");
  const [titleTemplate, setTitleTemplate] = useState("");
  const { data, error, isLoading } = useQuery(
    {
      query: databaseAutomationsQuery,
      variables: {
        workspaceId,
        first: 100,
        offset: 0,
      },
    },
    DATABASE_AUTOMATION_QUERY_CONFIG,
  );

  const automations = useMemo(
    () =>
      (data?.workspace?.automations ?? []).filter(
        (automation) => automation.trigger.databaseId === databaseId,
      ),
    [data?.workspace?.automations, databaseId],
  );
  const automationLabel = (automation: WorkspaceAutomationFragment) => {
    const personal = [ownPreparationRule, ownMaintenanceRule].find(
      (rule) => rule?.id === automation.id,
    );
    if (!personal) return automation.name;
    const source = personalSources.find(
      (source) =>
        source.identity.id === personal.package.id &&
        source.identity.version === personal.package.version &&
        source.identity.digest === personal.package.digest,
    );
    return source
      ? assistantText(source.name, t.language)
      : t["com.myoxus.assistance.title"]();
  };
  const runs = useMemo(() => {
    const automationIds = new Set(
      automations.map((automation) => automation.id),
    );
    return (data?.workspace?.automationRuns ?? [])
      .filter(
        (run) =>
          run.automationId != null && automationIds.has(run.automationId),
      )
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  }, [automations, data?.workspace?.automationRuns]);

  const refresh = useCallback(
    () =>
      revalidate(
        databaseAutomationsQuery,
        (variables) => variables.workspaceId === workspaceId,
      ),
    [revalidate, workspaceId],
  );

  const openCreate = useCallback(() => {
    setAutomationName(
      t["com.myoxus.database.automation.create.default-name"](),
    );
    setAutomationDescription("");
    setTitleTemplate(
      t["com.myoxus.database.automation.create.default-title-template"]({
        rowId: "{{rowId}}",
      }),
    );
    setCreateOpen(true);
  }, [t]);

  const onCreateAutomation = useCallback(async () => {
    const name = automationName.trim();
    const template = titleTemplate.trim();
    if (!canEdit || !name || !template) return;
    try {
      await createAutomation.trigger({
        input: {
          workspaceId,
          name,
          description: automationDescription.trim() || null,
          trigger: {
            triggerType: WorkspaceAutomationTriggerKind.RowCreated,
            databaseId,
          },
          actions: [
            {
              position: 0,
              config: {
                createLinkedDocument: {
                  titleTemplate: template,
                  relationFieldId: null,
                },
              },
            },
          ],
        },
      });
      await refresh();
      setCreateOpen(false);
      notify.success({
        title: t["com.myoxus.database.automation.create.success"](),
      });
    } catch (createError) {
      notify.error({
        title: t["com.myoxus.database.automation.create.failed"](),
        message: String(createError),
      });
    }
  }, [
    automationDescription,
    automationName,
    canEdit,
    createAutomation,
    databaseId,
    refresh,
    t,
    titleTemplate,
    workspaceId,
  ]);

  const onDisableAutomation = async (
    automation: WorkspaceAutomationFragment,
  ) => {
    const ownRule =
      automation.id === ownMaintenanceRule?.id
        ? ownMaintenanceRule
        : automation.id === ownPreparationRule?.id
          ? ownPreparationRule
          : undefined;
    if (ownRule && knownPersonalRule(ownRule)) {
      configurePersonal(false, ownRule, ownRule.id === ownMaintenanceRule?.id);
      return;
    }
    if (!canEdit) return;
    try {
      await disableAutomation.trigger({
        input: { automationId: automation.id },
      });
      await refresh();
      notify.success({
        title: t["com.myoxus.database.automation.disable.success"](),
      });
    } catch (disableError) {
      notify.error({
        title: t["com.myoxus.database.automation.disable.failed"](),
        message: String(disableError),
      });
    }
  };

  return (
    <Stack data-testid="database-automations-panel">
      {!personalSource && !preparationRunId && personalFailed ? (
        <Notice tone="warning">
          {t["com.myoxus.common.operation-failed"]()}
        </Notice>
      ) : null}
      {ruleDiscoveryFailed ? (
        <Notice tone="warning">
          {t["com.myoxus.common.operation-failed"]()}
          <Button onClick={() => setRuleDiscoveryRevision((v) => v + 1)}>
            {t.Retry()}
          </Button>
        </Notice>
      ) : null}
      {canUseTaskAssistance && packages.isLoading ? (
        <Loading />
      ) : canUseTaskAssistance && packages.error ? (
        <Notice tone="warning">
          {t["com.myoxus.common.operation-failed"]()}
          <Button onClick={() => void packages.mutate()}>{t.Retry()}</Button>
        </Notice>
      ) : personalAvailable ? (
        <Group>
          {personalSources.map((source) => (
            <Button
              key={source.identity.id}
              onClick={() => openPersonal(source)}
            >
              {assistantText(source.name, t.language)}
            </Button>
          ))}
        </Group>
      ) : null}
      {personalAvailable && personalSource ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open && !personalBusy) {
              ++personalEpoch.current;
              setPersonalSource(undefined);
            }
          }}
          title={assistantText(personalSource.name, t.language)}
        >
          <Stack ref={personalValidation.formRef}>
            {!confirmedConfig && !personalEditing && personalLoaded ? (
              <SavedSetupControls
                {...saved}
                disabled={personalOperationBusy || !canUseTaskAssistance}
                canSave={Boolean(personalSource)}
                canLoad={personalLoaded}
                onSave={() => {
                  if (
                    !personalPreflight() ||
                    personalFlight.current ||
                    confirmedConfig ||
                    personalEditing ||
                    !personalLoaded ||
                    !personalValidation.validate()
                  )
                    return;
                  saved.save({
                    package: {
                      identity: personalSource.identity,
                      answers: assistantAnswerPayload(
                        visibleAssistantAnswers(
                          personalSource,
                          personalAnswers,
                        ),
                      ),
                    },
                  });
                }}
                onLoad={() =>
                  saved.load(async (resolution) => {
                    if (
                      !personalPreflight() ||
                      personalFlight.current ||
                      confirmedConfig ||
                      personalEditing ||
                      !personalLoaded
                    )
                      return false;
                    const epoch = personalEpoch.current,
                      identity = owner.identity;
                    const latest = await packages.mutate();
                    if (
                      !personalCurrent(epoch, identity) ||
                      latest?.workspace?.id !== workspaceId
                    )
                      return false;
                    const next = savedSetupDescriptor(
                      latest.workspace.assistantPackages,
                      resolution.package,
                    );
                    if (
                      !next ||
                      !next.components.some(
                        (component) =>
                          component.action.kind ===
                            AssistantNativeActionKind.ConfigureTaskPreparation ||
                          component.action.kind ===
                            AssistantNativeActionKind.TaskMaintenance,
                      )
                    )
                      return false;
                    const maintenance = next.components.some(
                      (component) =>
                        component.action.kind ===
                        AssistantNativeActionKind.TaskMaintenance,
                    );
                    const nextKey = `context-documents:configuration:${JSON.stringify([owner.server?.id, owner.account?.id, workspaceId, databaseId, maintenance ? "taskMaintenance" : "taskPreparation"])}`;
                    const pending =
                      await readConfirmedAssistantAttempt<ConfigureTaskPreparationInput>(
                        storage,
                        nextKey,
                        validateConfig,
                      );
                    if (!personalCurrent(epoch, identity) || pending)
                      return false;
                    // Re-read this target's rule only for its current identity/revision.
                    // Saved defaults never inherit its private answers or enablement.
                    const rule = await readPersonal(
                      maintenance,
                      epoch,
                      identity,
                    );
                    if (!personalCurrent(epoch, identity) || rule === undefined)
                      return false;
                    ++personalEpoch.current;
                    setPersonalSource(next);
                    setPersonalAnswers(
                      savedSetupAnswers(next, resolution.package),
                    );
                    setPersonalPlan(undefined);
                    personalReviewedRule.current = undefined;
                    personalValidation.reset();
                    setPersonalFailed(false);
                    return true;
                  })
                }
              />
            ) : null}
            <Notice>
              {t["com.myoxus.database.automation.personal-mode"]()}
            </Notice>
            {personalFailed ? (
              <Notice tone="warning">
                {confirmedConfig
                  ? t["com.myoxus.database.automation.personal-unknown"]()
                  : t["com.myoxus.common.operation-failed"]()}
              </Notice>
            ) : null}
            {!personalLoaded ? <Loading /> : null}
            {personalRule ? (
              <Badge>
                {workspaceAutomationStatusLabel(t, personalRule.status)}
              </Badge>
            ) : null}
            {!confirmedConfig || personalEditing
              ? personalSource.presentation.steps.map((step) => (
                  <AssistantGroups
                    key={step.id}
                    descriptor={personalSource}
                    stepId={step.id}
                    groups={step.groups}
                    adapters={{}}
                    answers={personalAnswers}
                    disabled={personalBusy}
                    artworkServer={owner.server}
                    invalidInputs={personalValidation.invalidInputs}
                    onAnswer={(input, value) => {
                      setPersonalAnswers((previous) => {
                        const next = { ...previous };
                        if (value) next[input.id] = value;
                        else delete next[input.id];
                        return next;
                      });
                      setPersonalPlan(undefined);
                    }}
                  />
                ))
              : null}
            {confirmedConfig &&
            personalRule &&
            !configMatches(confirmedConfig, personalRule) ? (
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.database.conflict.server-value"]()}
                </MyoxusText>
                {personalRule.package.id === personalSource.identity.id &&
                personalRule.package.version ===
                  personalSource.identity.version &&
                personalRule.package.digest ===
                  personalSource.identity.digest ? (
                  <AssistantGroups
                    descriptor={personalSource}
                    adapters={{}}
                    groups={personalSource.presentation.steps.flatMap((step) =>
                      step.groups.map((group) => ({
                        ...group,
                        controls: group.controls.filter(
                          (control) =>
                            control.kind === AssistantControlKind.Input,
                        ),
                      })),
                    )}
                    answers={Object.fromEntries(
                      personalRule.answers.map((a) => [a.input, a.value]),
                    )}
                    disabled
                  />
                ) : (
                  <MyoxusText>
                    {t["com.myoxus.database.setup.status.unavailable"]()}
                  </MyoxusText>
                )}
              </Stack>
            ) : null}
            {confirmedConfig && !personalEditing ? (
              confirmedDisplay ? (
                <Stack>
                  <MyoxusText>
                    {t["com.myoxus.database.conflict.local-value"]()}
                  </MyoxusText>
                  {personalSource.presentation.steps.map((step) => (
                    <AssistantGroups
                      key={step.id}
                      descriptor={personalSource}
                      stepId={step.id}
                      groups={step.groups}
                      adapters={{}}
                      answers={confirmedDisplay}
                      disabled
                      artworkServer={owner.server}
                    />
                  ))}
                </Stack>
              ) : (
                <Notice tone="warning">
                  {t["com.myoxus.database.setup.status.unavailable"]()}
                </Notice>
              )
            ) : null}
            {personalPlan ? (
              <AssistantGroups
                descriptor={personalSource}
                groups={personalSource.presentation.dialogs.flatMap(
                  (dialog) => dialog.groups,
                )}
                answers={Object.fromEntries(
                  personalPlan.answers.map((answer) => [
                    answer.input,
                    answer.value,
                  ]),
                )}
                disabled
                adapters={{
                  control: (control) =>
                    control.kind ===
                      AssistantControlKind.TaskMaintenanceReview &&
                    "proposal" in personalPlan ? (
                      <TaskMaintenancePlan
                        plan={personalPlan}
                        current={personalPreviewCurrent}
                      />
                    ) : control.kind ===
                        AssistantControlKind.TaskPreparationReview &&
                      "source" in personalPlan ? (
                      <Stack>
                        <MyoxusText>{personalPlan.source.title}</MyoxusText>
                        <MyoxusText>{personalPlan.source.locale}</MyoxusText>
                        <MyoxusText>
                          {personalPlan.source.source.version}
                        </MyoxusText>
                      </Stack>
                    ) : undefined,
                }}
              />
            ) : null}
            <Group>
              <Button
                disabled={personalBusy}
                onClick={() => {
                  ++personalEpoch.current;
                  setPersonalSource(undefined);
                }}
              >
                {t.Cancel()}
              </Button>
              <Button
                disabled={personalBusy}
                onClick={() =>
                  void personalRun(async (epoch, identity) => {
                    const rule = await readPersonal(
                      maintenanceConfig,
                      epoch,
                      identity,
                    );
                    if (
                      confirmedConfig &&
                      rule !== undefined &&
                      configMatches(confirmedConfig, rule)
                    ) {
                      await saveConfirmedAssistantAttempt(
                        storage,
                        configKey,
                        undefined,
                        validateConfig,
                      );
                      if (personalCurrent(epoch, identity))
                        setConfirmedConfig(undefined);
                    }
                  })
                }
              >
                {t["com.myoxus.database.setup.check"]()}
              </Button>
              {!confirmedConfig || personalEditing ? (
                <Button
                  disabled={personalBusy || !personalLoaded}
                  onClick={preparePersonal}
                >
                  {t["com.myoxus.database.automation.personal-review"]()}
                </Button>
              ) : null}
              {(confirmedConfig && !personalEditing) || personalPlan ? (
                <Button
                  disabled={
                    personalBusy ||
                    !personalLoaded ||
                    (Boolean(confirmedConfig) &&
                      !personalEditing &&
                      !confirmedDisplay) ||
                    ((!confirmedConfig || personalEditing) &&
                      !personalPlan?.executionAvailable)
                  }
                  onClick={() => configurePersonal(true)}
                >
                  {confirmedConfig && !personalEditing
                    ? t.Retry()
                    : t["com.myoxus.database.automation.personal-enable"]()}
                </Button>
              ) : null}
              {confirmedConfig && !personalEditing ? (
                <Button
                  disabled={personalBusy || !personalLoaded}
                  onClick={() =>
                    void personalRun(async (epoch, identity) => {
                      const rule = await readPersonal(
                        maintenanceConfig,
                        epoch,
                        identity,
                      );
                      if (
                        !personalCurrent(epoch, identity) ||
                        rule === undefined
                      )
                        return;
                      setPersonalEditing(true);
                      setPersonalPlan(undefined);
                    })
                  }
                >
                  {t["com.myoxus.database.review.edit-unaccepted"]()}
                </Button>
              ) : null}
              {!confirmedConfig &&
              personalRule?.status === WorkspaceAutomationStatus.Enabled ? (
                <Button
                  disabled={personalBusy}
                  onClick={() => configurePersonal(false)}
                >
                  {t["com.myoxus.database.automation.disable"]()}
                </Button>
              ) : null}
            </Group>
          </Stack>
        </Modal>
      ) : null}
      {isLoading ? (
        <Loading />
      ) : error ? (
        <EmptyState
          title={t["com.myoxus.database.automation.description"]()}
          cta={<Button onClick={() => void refresh()}>{t.Retry()}</Button>}
        />
      ) : (
        <>
          <Group justify="space-between" align="start" wrap="wrap">
            <MyoxusText tone="secondary">
              {t["com.myoxus.database.automation.description"]()}
            </MyoxusText>
            <Button
              prefix={<PlusIcon />}
              variant="secondary"
              onClick={openCreate}
              disabled={!canEdit}
              data-testid="database-automation-create"
            >
              {t["com.myoxus.database.automation.create.open"]()}
            </Button>
          </Group>

          {automations.length ? (
            <Accordion
              multiple
              defaultValue={automations.map((automation) => automation.id)}
              aria-label={t["com.myoxus.database.automation.list-label"]()}
            >
              {automations.map((automation) => (
                <AccordionItem
                  key={automation.id}
                  value={automation.id}
                  data-testid="database-automation"
                >
                  <AccordionControl>
                    <Group gap="xs" wrap="wrap">
                      <MyoxusText component="span" typographySlot="body-small">
                        {automationLabel(automation)}
                      </MyoxusText>
                      <Badge
                        tone={
                          automation.status ===
                          WorkspaceAutomationStatus.Enabled
                            ? "success"
                            : "neutral"
                        }
                      >
                        {workspaceAutomationStatusLabel(t, automation.status)}
                      </Badge>
                    </Group>
                  </AccordionControl>
                  <AccordionPanel>
                    <Stack gap="xs">
                      {automation.description ? (
                        <MyoxusText
                          tone="secondary"
                          typographySlot="body-small"
                        >
                          {automation.description}
                        </MyoxusText>
                      ) : null}
                      <Badge tone="info">
                        {workspaceAutomationTriggerLabel(
                          t,
                          automation.trigger.triggerType,
                        )}
                      </Badge>
                      {automation.status ===
                      WorkspaceAutomationStatus.Enabled ? (
                        <Group justify="flex-end">
                          <Button
                            variant="secondary"
                            disabled={
                              personalBusy ||
                              (!canEdit &&
                                !(
                                  automation.id === ownMaintenanceRule?.id ||
                                  automation.id === ownPreparationRule?.id
                                ))
                            }
                            onClick={() => void onDisableAutomation(automation)}
                            loading={disableAutomation.isMutating}
                          >
                            {t["com.myoxus.database.automation.disable"]()}
                          </Button>
                        </Group>
                      ) : null}
                    </Stack>
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          ) : (
            <EmptyState
              title={
                <EmptyStateTitle icon={<DatabaseIcon />}>
                  {t["com.myoxus.database.automation.empty-title"]()}
                </EmptyStateTitle>
              }
              description={t[
                "com.myoxus.database.automation.empty-description"
              ]()}
            />
          )}

          <Button
            disabled={personalBusy}
            onClick={() => {
              const epoch = personalEpoch.current,
                identity = owner.identity;
              setPersonalFailed(false);
              void refresh().catch(() => {
                if (personalCurrent(epoch, identity)) setPersonalFailed(true);
              });
            }}
          >
            {t["com.myoxus.sidebar.action.refresh"]()}
          </Button>
          <DatabaseAutomationRuns
            runs={runs}
            maintenanceRuleId={knownMaintenanceRuleId}
            onOpenMaintenanceRun={openMaintenanceRun}
            preparationRuleId={ownPreparationRule?.id}
            onOpenPreparationRun={openPreparationRun}
          />
          <Modal
            open={Boolean(preparationRunId)}
            returnFocusRef={preparationRunTrigger}
            persistent={personalBusy}
            title={t["com.myoxus.database.automation.runs-title"]()}
            onOpenChange={(open) => {
              if (!open && !personalBusy) {
                ++personalEpoch.current;
                setPreparationRunId(undefined);
                setPreparationRun(undefined);
              }
            }}
          >
            <Stack>
              {personalBusy ? <Loading /> : null}
              {personalFailed ? (
                <Notice tone="warning">
                  {t["com.myoxus.common.operation-failed"]()}
                </Notice>
              ) : null}
              {preparationRun ? (
                <>
                  <DatabaseAutomationRuns runs={[preparationRun.run]} />
                  <TaskRowReference
                    framework={framework}
                    target={{ workspaceId, ...preparationRun.target }}
                    onOpen={(target) => {
                      if (
                        personalPreviewCurrent() &&
                        target.workspaceId === workspaceId
                      )
                        workbench.open(
                          `/tasks?${new URLSearchParams({ databaseId: target.databaseId, rowId: target.rowId })}`,
                          { at: "tail" },
                        );
                    }}
                  />
                  {preparationRun.documentId &&
                  preparationRun.documentExternalId ? (
                    <Button
                      onClick={() => {
                        if (personalPreviewCurrent())
                          workbench.openDoc(
                            preparationRun.documentExternalId!,
                            { at: "tail" },
                          );
                      }}
                    >
                      {t["com.myoxus.database.document_link.open"]()}
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Group>
                <Button
                  disabled={personalBusy}
                  onClick={() => controlPreparationRun()}
                >
                  {t["com.myoxus.database.setup.check"]()}
                </Button>
                {preparationRun?.canRetry ? (
                  <Button
                    disabled={personalBusy}
                    onClick={() => controlPreparationRun("retry")}
                  >
                    {t.Retry()}
                  </Button>
                ) : null}
                {preparationRun?.canStop ? (
                  <Button
                    disabled={personalBusy}
                    onClick={() => controlPreparationRun("stop")}
                  >
                    {t["com.myoxus.recording.stop"]()}
                  </Button>
                ) : null}
              </Group>
            </Stack>
          </Modal>

          <Modal
            open={createOpen}
            onOpenChange={setCreateOpen}
            title={t["com.myoxus.database.automation.create.title"]()}
          >
            <Stack gap="md">
              <FormRow
                label={t["com.myoxus.database.automation.create.name"]()}
              >
                <Input value={automationName} onChange={setAutomationName} />
              </FormRow>
              <FormRow
                label={t["com.myoxus.database.automation.create.description"]()}
              >
                <Textarea
                  value={automationDescription}
                  onChange={setAutomationDescription}
                />
              </FormRow>
              <FormRow
                label={t[
                  "com.myoxus.database.automation.create.title-template"
                ]()}
              >
                <Input value={titleTemplate} onChange={setTitleTemplate} />
              </FormRow>
              <Group justify="end">
                <Button
                  variant="secondary"
                  onClick={() => setCreateOpen(false)}
                >
                  {t["Cancel"]()}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void onCreateAutomation()}
                  loading={createAutomation.isMutating}
                  disabled={
                    !canEdit || !automationName.trim() || !titleTemplate.trim()
                  }
                >
                  {t["com.myoxus.database.automation.create.submit"]()}
                </Button>
              </Group>
            </Stack>
          </Modal>
        </>
      )}
    </Stack>
  );
}
