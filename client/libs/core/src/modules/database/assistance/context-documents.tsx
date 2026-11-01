// SPDX-License-Identifier: AGPL-3.0-or-later
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { projectCreationInputAdapter } from "@myoxus/core/desktop/pages/workspace/databases/creation-assistant/project-creation-form";
import { OrganizeService } from "@myoxus/core/modules/organize/services/organize";
import { UserPreferencesService } from "@myoxus/core/modules/server/services/user-preferences";
import { GlobalState } from "@myoxus/core/modules/storage";
import type { Server } from "@myoxus/core/modules/server/entities/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { collectWorkspaceFolderOptions } from "@myoxus/core/modules/workspace-pages/organizer";
import { TEMPLATE_SUGGESTION_CLIENT_VERSION } from "@myoxus/core/modules/template-doc/services/template-doc";
import { UserFriendlyError } from "@myoxus/error";
import {
  AssistantActionKind,
  AssistantContext,
  AssistantControlKind,
  AssistantInputTarget,
  AssistantNativeActionKind,
  AssistantValueType,
  AssistanceMode,
  ProjectSetupStatus,
  WorkspaceAutomationRunOrigin,
  WorkspaceAutomationRunStatus,
  applyContextDocumentsMutation,
  contextDocumentsQuery,
  prepareContextDocumentsQuery,
  stopContextDocumentsMutation,
  retryContextDocumentsMutation,
  prepareDocumentReviewQuery,
  documentReviewRequestQuery,
  startDocumentReviewMutation,
  stopDocumentReviewMutation,
  retryDocumentReviewMutation,
  prepareTaskMaintenanceQuery,
  taskMaintenanceRequestQuery,
  taskMaintenanceQuery,
  startTaskMaintenanceMutation,
  retryTaskMaintenanceMutation,
  stopTaskMaintenanceMutation,
  confirmTaskCorrectionsMutation,
  TaskCorrectionOutcome,
  type PreparedTaskMaintenanceFragmentFragment,
  type TaskMaintenanceFragmentFragment,
  prepareTaskHandoverQuery,
  taskHandoverRequestQuery,
  startTaskHandoverMutation,
  stopTaskHandoverMutation,
  retryTaskHandoverMutation,
  type TaskHandoverFragmentFragment,
  type PreparedTaskHandoverFragmentFragment,
  type DocumentReviewFragmentFragment,
  type PreparedDocumentReviewFragmentFragment,
  type AssistantActionFragmentFragment,
  type AssistantPackageFragmentFragment,
  type ContextDocumentsFragmentFragment,
  type PreparedContextDocumentsFragmentFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  IconButton,
  Menu as DropdownMenu,
  MenuPanel,
  FormRow,
  Group,
  Loading,
  MenuItem,
  MyoxusText,
  Notice,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@myoxus/ui-facade";
import { createPortal } from "react-dom";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AssistantActions,
  AssistantGroups,
  assistantFormAction,
  assistantActionLabel,
  type AssistantNativeAdapters,
} from "../presentation/renderer";
import {
  AssistantNativeDialog,
  useAssistantNavigation,
} from "../presentation/native-form";
import { useAssistantPackage } from "../presentation/use-assistant-package";
import { useAssistantFormValidation } from "../presentation/use-form-validation";
import {
  assistantAnswerPayload,
  assistantText,
  assistantValue,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "../presentation/values";
import { classifyDatabaseError } from "../route-state";
import {
  workspaceAutomationRunStatusLabel,
  workspaceAutomationRunTone,
} from "../workbench-context/database-automations";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import {
  contextDocumentsAttemptKey,
  readContextDocumentsAttempt,
  saveContextDocumentsAttempt,
  type ContextDocumentsAttempt,
} from "./context-documents-attempt";

import {
  ContextDocumentAssistanceContext,
  type ContextDocumentMenuTarget,
  type ContextDocumentMenu as Menu,
} from "./context";

import {
  DocumentTaskPlan,
  DocumentReviewResults,
  documentReviewInput,
  nativeTaskAnswersFromTransport,
} from "./document-review";
import {
  ContextRecoveryMenu,
  useRetainedContextAttempts,
} from "./context-recovery-menu";
import { TaskMaintenancePlan } from "./task-maintenance";
import { TaskHandoverProgress, TaskHandoverResults } from "./task-handover";
import { TaskReferencesInput } from "../presentation/task-references-input";

type ContextPreparation =
  | PreparedTaskMaintenanceFragmentFragment
  | PreparedContextDocumentsFragmentFragment
  | PreparedDocumentReviewFragmentFragment
  | PreparedTaskHandoverFragmentFragment;
type ContextOutcome =
  | TaskMaintenanceFragmentFragment
  | ContextDocumentsFragmentFragment
  | DocumentReviewFragmentFragment
  | TaskHandoverFragmentFragment;
const maintenanceOutcome = (
  value: ContextOutcome,
): value is TaskMaintenanceFragmentFragment => "canApply" in value;
const maintenancePlan = (
  value: ContextPreparation,
): value is PreparedTaskMaintenanceFragmentFragment => "proposal" in value;
const reviewOutcome = (
  value: ContextOutcome,
): value is DocumentReviewFragmentFragment => "reviewTaskId" in value;
const reviewPlan = (
  value: ContextPreparation,
): value is PreparedDocumentReviewFragmentFragment => "reviewerId" in value;
const handoverOutcome = (
  value: ContextOutcome,
): value is TaskHandoverFragmentFragment => "resultTaskId" in value;
const handoverPlan = (
  value: ContextPreparation,
): value is PreparedTaskHandoverFragmentFragment => "prerequisites" in value;
const documentsOutcome = (
  value: ContextOutcome,
): value is ContextDocumentsFragmentFragment => "documents" in value;
const documentsPlan = (
  value: ContextPreparation,
): value is PreparedContextDocumentsFragmentFragment => "documents" in value;
const outcomeProduct = (value: ContextOutcome) =>
  maintenanceOutcome(value)
    ? "taskMaintenance"
    : reviewOutcome(value)
      ? "documentReview"
      : handoverOutcome(value)
        ? "taskHandover"
        : undefined;

/** Native result projections alone authorize retained recovery, including when
 * the current catalog no longer offers the accepted immutable descriptor. */
function matchesContextOutcome(
  value: ContextOutcome,
  input: ContextDocumentsAttempt,
  workspaceId: string,
  actorId: string | undefined,
  target: ContextDocumentMenuTarget,
) {
  return !(
    (documentsOutcome(value) || maintenanceOutcome(value)
      ? value.requestId
      : value.run.requestId) !== input.input.requestId ||
    outcomeProduct(value) !== input.product ||
    (value.run != null &&
      (value.run.origin !==
        (maintenanceOutcome(value)
          ? input.maintenanceRunId
            ? WorkspaceAutomationRunOrigin.Rule
            : WorkspaceAutomationRunOrigin.TaskMaintenance
          : reviewOutcome(value)
            ? WorkspaceAutomationRunOrigin.DocumentReview
            : handoverOutcome(value)
              ? WorkspaceAutomationRunOrigin.TaskHandover
              : WorkspaceAutomationRunOrigin.ConfirmedRequest) ||
        value.run.workspaceId !== workspaceId ||
        (input.maintenanceRunId
          ? value.run.id !== input.maintenanceRunId
          : value.run.requestId !== input.input.requestId))) ||
    (value.acceptedDescriptor != null &&
      (value.acceptedDescriptor.identity.id !== input.input.identity.id ||
        value.acceptedDescriptor.identity.version !==
          input.input.identity.version ||
        value.acceptedDescriptor.identity.digest !==
          input.input.identity.digest)) ||
    (maintenanceOutcome(value) &&
      (value.acceptedPlan.actorId !== actorId ||
        value.acceptedPlan.workspaceId !== workspaceId)) ||
    value.acceptedPlan.package.id !== input.input.identity.id ||
    value.acceptedPlan.package.version !== input.input.identity.version ||
    value.acceptedPlan.package.digest !== input.input.identity.digest ||
    value.acceptedPlan.target.databaseId !== target.databaseId ||
    (value.acceptedPlan.target.taskId ?? null) !== (target.taskId ?? null)
  );
}

async function readNativeContextAttempt(
  server: Server,
  workspaceId: string,
  saved: ContextDocumentsAttempt,
) {
  if (saved.product === "taskMaintenance") {
    const response = saved.maintenanceRunId
      ? await server.gql({
          query: taskMaintenanceQuery,
          variables: { workspaceId, runId: saved.maintenanceRunId },
        })
      : await server.gql({
          query: taskMaintenanceRequestQuery,
          variables: { workspaceId, requestId: saved.input.requestId },
        });
    return {
      actorId: response.currentUser?.id,
      workspaceId: response.workspace?.id,
      value: response.workspace
        ? "taskMaintenance" in response.workspace
          ? response.workspace.taskMaintenance
          : response.workspace.taskMaintenanceRequest
        : undefined,
    };
  }
  if (saved.product === "taskHandover") {
    const response = await server.gql({
      query: taskHandoverRequestQuery,
      variables: { workspaceId, requestId: saved.input.requestId },
    });
    return {
      actorId: response.currentUser?.id,
      workspaceId: response.workspace?.id,
      value: response.workspace?.taskHandoverRequest,
    };
  }
  if (saved.product === "documentReview") {
    const response = await server.gql({
      query: documentReviewRequestQuery,
      variables: { workspaceId, requestId: saved.input.requestId },
    });
    return {
      actorId: response.currentUser?.id,
      workspaceId: response.workspace?.id,
      value: response.workspace?.documentReviewRequest,
    };
  }
  const response = await server.gql({
    query: contextDocumentsQuery,
    variables: { workspaceId, requestId: saved.input.requestId },
  });
  return {
    actorId: response.currentUser?.id,
    workspaceId: response.workspace?.id,
    value: response.workspace?.contextDocuments,
  };
}

/** The menu resolves only this concrete target's existing transport slots. */
function RetainedContextMenu({
  owner,
  target,
  onOpen,
}: {
  owner: ReturnType<typeof useTaskIdentity>;
  target: ContextDocumentMenuTarget;
  onOpen: (attempt: ContextDocumentsAttempt) => void;
}) {
  const attempts = useRetainedContextAttempts(
    owner.server?.id ?? "",
    owner.account?.id ?? "",
    owner.workspace.id,
    target,
  );
  return <ContextRecoveryMenu attempts={attempts} onOpen={onOpen} />;
}

/** Native Task row menu keeps its real trigger mounted while Assistance opens. */
export function ContextDocumentTaskMenu({
  target,
  onOpenProject,
}: {
  target: ContextDocumentMenuTarget;
  onOpenProject: () => void;
}) {
  const t = useI18n();
  const { menu, available } = useContext(ContextDocumentAssistanceContext);
  const trigger = useRef<HTMLButtonElement>(null);
  // A Workspace task has no Project navigation. The host also accounts for
  // retained runs and catalog recovery before hiding an otherwise empty menu.
  if (!available && !target.projectId) return null;
  return (
    <DropdownMenu
      items={
        <MenuPanel>
          {menu({ ...target, returnFocusRef: trigger })}
          {target.projectId ? (
            <MenuItem onSelect={onOpenProject}>
              {t["com.myoxus.database.tasks.open-project"]()}
            </MenuItem>
          ) : null}
        </MenuPanel>
      }
    >
      <IconButton
        ref={trigger}
        aria-label={t["com.myoxus.common.task-actions"]()}
        tooltip={t["com.myoxus.common.task-actions"]()}
      >
        <MoreHorizontalIcon />
      </IconButton>
    </DropdownMenu>
  );
}

/** The owner lives beside the Database/Tasks host, never inside a collapsible
 * Context Surface. Only controlled presentation is mounted by that surface. */
export function ContextDocumentAssistance({
  databaseId,
  title,
  projectId,
  enabled,
  onShow,
  onClose,
  requestOpen,
  children,
}: {
  databaseId?: string | null;
  title: string;
  projectId?: string;
  enabled: boolean;
  onShow: () => void;
  onClose: () => void;
  /** The host admits leaving its current editor before opening or reading a run. */
  requestOpen?: (open: () => void) => void;
  children: (props: {
    menu: Menu;
    content: ReactNode;
    available: boolean;
  }) => ReactNode;
}) {
  const owner = useTaskIdentity();
  const t = useI18n();
  const hostAttempts = useRetainedContextAttempts(
    owner.server?.id ?? "",
    owner.account?.id ?? "",
    owner.workspace.id,
    databaseId ? { databaseId, title, projectId } : undefined,
  );
  const catalog = useAssistantPackage(
    AssistantContext.TaskContainerAssistance,
    enabled,
  );
  const [selection, setSelection] = useState<{
    descriptor: AssistantPackageFragmentFragment;
    target: ContextDocumentMenuTarget;
    maintenanceRun?: TaskMaintenanceFragmentFragment;
    retained?: { attempt: ContextDocumentsAttempt; outcome: ContextOutcome };
  }>();
  const [formContainer, setFormContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [sessionOpen, setSessionOpen] = useState(false);
  const identity = owner.identity;
  const runOpenEpoch = useRef(0);
  const [runOpenFailed, setRunOpenFailed] = useState(false);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    ++runOpenEpoch.current;
    setSelection(undefined);
    setSessionOpen(false);
    // Observe transitions, including logout-and-return batched to the same
    // React identity, so reopening cannot retain an invalidated session.
    const actorId = owner.account?.id;
    const subscription = owner.server?.account$.subscribe((account) => {
      if (account?.id !== actorId) {
        ++runOpenEpoch.current;
        setSelection(undefined);
        setSessionOpen(false);
      }
    });
    return () => {
      ++runOpenEpoch.current;
      subscription?.unsubscribe();
    };
  }, [identity, owner.server, owner.account?.id]);
  const packages =
    !enabled ||
    !identity ||
    catalog.error ||
    catalog.data?.workspace?.id !== owner.workspace.id
      ? []
      : (catalog.data.workspace.assistantPackages ?? []).filter(
          (descriptor) =>
            !descriptor.components.some(
              (component) =>
                component.action.kind ===
                AssistantNativeActionKind.ConfigureTaskPreparation,
            ),
        );
  const catalogUnavailable = Boolean(
    catalog.error ||
    (catalog.data &&
      (!catalog.data.workspace ||
        catalog.data.workspace.id !== owner.workspace.id)),
  );
  // A successful empty catalog is intentional withdrawal, not a failed read.
  const available = Boolean(
    enabled &&
    identity &&
    (hostAttempts.length > 0 ||
      catalogUnavailable ||
      catalog.isLoading ||
      (catalog.data?.workspace?.id === owner.workspace.id &&
        catalog.data.workspace.assistantPackages.length > 0)),
  );
  const retryCatalog = () => {
    formContainer?.focus();
    void catalog.mutate(undefined, { revalidate: true, throwOnError: false });
  };
  const openMaintenanceRun = (runId: string, opener?: HTMLElement | null) => {
    if (!owner.server || !identity || owner.availability.status !== "available")
      return;
    const open = () => {
      if (identityRef.current !== identity) return;
      const epoch = ++runOpenEpoch.current;
      setSelection(undefined);
      setSessionOpen(true);
      setRunOpenFailed(false);
      onShow();
      void owner
        .server!.gql({
          query: taskMaintenanceQuery,
          variables: { workspaceId: owner.workspace.id, runId },
        })
        .then(
          (response) => {
            if (
              epoch !== runOpenEpoch.current ||
              identityRef.current !== identity
            )
              return;
            const run = response.workspace?.taskMaintenance;
            if (
              response.currentUser?.id !== owner.account?.id ||
              response.workspace?.id !== owner.workspace.id ||
              !run ||
              run.run.id !== runId ||
              run.run.workspaceId !== owner.workspace.id ||
              run.acceptedPlan.workspaceId !== owner.workspace.id ||
              !run.acceptedDescriptor ||
              run.acceptedDescriptor.identity.id !==
                run.acceptedPlan.package.id ||
              run.acceptedDescriptor.identity.version !==
                run.acceptedPlan.package.version ||
              run.acceptedDescriptor.identity.digest !==
                run.acceptedPlan.package.digest
            ) {
              setRunOpenFailed(true);
              return;
            }
            setSelection({
              descriptor: run.acceptedDescriptor,
              target: {
                ...run.acceptedPlan.target,
                title:
                  databaseId === run.acceptedPlan.target.databaseId
                    ? title
                    : "",
                opener,
              },
              maintenanceRun: run,
            });
            setSessionOpen(true);
          },
          () => {
            if (
              epoch === runOpenEpoch.current &&
              identityRef.current === identity
            )
              setRunOpenFailed(true);
          },
        );
    };
    if (requestOpen) requestOpen(open);
    else open();
  };
  const openRetainedAttempt = (
    saved: ContextDocumentsAttempt,
    target: ContextDocumentMenuTarget,
  ) => {
    if (
      !owner.server ||
      !identity ||
      saved.gone ||
      saved.input.workspaceId !== owner.workspace.id ||
      saved.input.target.databaseId !== target.databaseId ||
      (saved.input.target.taskId ?? null) !== (target.taskId ?? null)
    )
      return;
    const open = () => {
      if (identityRef.current !== identity) return;
      const epoch = ++runOpenEpoch.current;
      setSelection(undefined);
      setRunOpenFailed(false);
      setSessionOpen(true);
      onShow();
      void readNativeContextAttempt(
        owner.server!,
        owner.workspace.id,
        saved,
      ).then(
        (response) => {
          if (
            epoch !== runOpenEpoch.current ||
            identityRef.current !== identity
          )
            return;
          const value = response.value;
          if (
            response.actorId !== owner.account?.id ||
            response.workspaceId !== owner.workspace.id ||
            !value?.acceptedDescriptor ||
            !matchesContextOutcome(
              value,
              saved,
              owner.workspace.id,
              owner.account?.id,
              target,
            )
          ) {
            setRunOpenFailed(true);
            return;
          }
          setSelection({
            descriptor: value.acceptedDescriptor,
            retained: { attempt: saved, outcome: value },
            target: {
              ...target,
              opener: target.returnFocusRef?.current ?? target.opener ?? null,
            },
          });
        },
        () => {
          if (
            epoch === runOpenEpoch.current &&
            identityRef.current === identity
          )
            setRunOpenFailed(true);
        },
      );
    };
    if (requestOpen) requestOpen(open);
    else open();
  };
  const freshMenu: Menu = (target) =>
    !enabled ||
    !identity ||
    owner.availability.status !== "available" ? null : catalog.isLoading ? (
      <MenuItem disabled>
        <Loading />
      </MenuItem>
    ) : catalogUnavailable ? (
      <>
        <MenuItem disabled>
          {t["com.myoxus.database.setup.status.unavailable"]()}
        </MenuItem>
        <MenuItem
          onSelect={() => {
            retryCatalog();
          }}
        >
          {t.Retry()}
        </MenuItem>
      </>
    ) : !packages.length ? null : (
      packages.map((descriptor) => (
        <MenuItem
          key={descriptor.identity.id}
          data-testid={`context-assistance-${descriptor.identity.id}`}
          onSelect={() => {
            const open = () => {
              if (identityRef.current !== identity) return;
              ++runOpenEpoch.current;
              setRunOpenFailed(false);
              const actual =
                target ??
                (databaseId ? { databaseId, title, projectId } : undefined);
              if (!actual) return;
              setSelection({
                descriptor,
                target: {
                  ...actual,
                  opener:
                    actual.returnFocusRef?.current ?? actual.opener ?? null,
                },
              });
              setSessionOpen(true);
              onShow();
            };
            if (requestOpen) requestOpen(open);
            else open();
          }}
        >
          {assistantText(descriptor.name, t.language)}
        </MenuItem>
      ))
    );
  const menu: Menu = (target) => {
    const actual =
      target ?? (databaseId ? { databaseId, title, projectId } : undefined);
    if (!enabled || !identity || owner.availability.status !== "available")
      return null;
    return (
      <>
        {actual ? (
          <RetainedContextMenu
            owner={owner}
            target={actual}
            onOpen={(saved) => openRetainedAttempt(saved, actual)}
          />
        ) : null}
        {freshMenu(target)}
      </>
    );
  };
  return (
    <ContextDocumentAssistanceContext.Provider
      value={{ menu, available, openMaintenanceRun }}
    >
      {children({
        menu,
        available,
        content:
          sessionOpen || runOpenFailed ? (
            <Stack
              ref={setFormContainer}
              tabIndex={-1}
              aria-label={t["com.myoxus.assistance.title"]()}
            >
              {runOpenFailed ? (
                <Notice tone="warning">
                  {t["com.myoxus.database.setup.status.unavailable"]()}
                </Notice>
              ) : null}
              {catalog.isLoading ? <Loading /> : null}
              {catalogUnavailable ? (
                <Notice tone="warning">
                  {t["com.myoxus.database.setup.status.unavailable"]()}
                  <Button onClick={retryCatalog}>{t.Retry()}</Button>
                </Notice>
              ) : null}
            </Stack>
          ) : null,
      })}
      {/* Catalog withdrawal removes fresh authority, never an explicitly opened
          controller with a durable native attempt. */}
      {selection && identity ? (
        <ContextDocumentsSession
          key={JSON.stringify([
            identity,
            selection.target.databaseId,
            selection.target.taskId ?? null,
            selection.descriptor.identity.id,
            selection.descriptor.identity.version,
            selection.descriptor.identity.digest,
            selection.maintenanceRun?.run.id,
          ])}
          initialMaintenanceRun={selection.maintenanceRun}
          initialRead={selection.retained}
          source={selection.descriptor}
          sourceActive={packages.some(
            (item) =>
              item.identity.id === selection.descriptor.identity.id &&
              item.identity.version === selection.descriptor.identity.version &&
              item.identity.digest === selection.descriptor.identity.digest,
          )}
          target={selection.target}
          container={sessionOpen ? formContainer : null}
          onClose={() => {
            ++runOpenEpoch.current;
            const opener = selection.target.opener;
            const sourceInSurface = Boolean(
              opener && formContainer?.contains(opener),
            );
            // Menu commands return to their durable header/row trigger after
            // closing the surface; the session owner retains recovery state.
            setSessionOpen(false);
            if (!sourceInSurface) onClose();
            opener?.focus();
          }}
        />
      ) : null}
    </ContextDocumentAssistanceContext.Provider>
  );
}

function ContextDocumentsSession({
  source: initialSource,
  initialMaintenanceRun: initialRun,
  initialRead,
  sourceActive,
  target,
  container,
  onClose,
}: {
  source: AssistantPackageFragmentFragment;
  initialMaintenanceRun?: TaskMaintenanceFragmentFragment;
  initialRead?: { attempt: ContextDocumentsAttempt; outcome: ContextOutcome };
  sourceActive: boolean;
  target: ContextDocumentMenuTarget;
  container: HTMLDivElement | null;
  onClose: () => void;
}) {
  // The keyed exact source identity is immutable. A catalog object refresh
  // must not reset an in-progress form or restart its receipt read.
  const source = useRef(initialSource).current;
  const initialMaintenanceRun = useRef(initialRun).current;
  const sourceActiveRef = useRef(sourceActive);
  sourceActiveRef.current = sourceActive;
  const owner = useTaskIdentity();
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const state = useService(GlobalState);
  const workbench = useService(WorkbenchService).workbench;
  const preferences = owner.server!.scope.get(UserPreferencesService);
  const revision = useLiveData(preferences.assistanceRevision$);
  const organizerRoot = useService(OrganizeService).folderTree.rootFolder;
  const children = useLiveData(organizerRoot.sortedChildren$);
  const folders = useMemo(() => {
    void children;
    return collectWorkspaceFolderOptions(organizerRoot);
  }, [organizerRoot, children]);
  const [answers, setAnswers] = useState<AssistantAnswers>(() =>
    visibleAssistantAnswers(source, {}, true),
  );
  const [attempt, setAttempt] = useState<ContextDocumentsAttempt>();
  const [outcome, setOutcome] = useState<ContextOutcome>();
  const [plan, setPlan] = useState<ContextPreparation>();
  const [maintenanceReviewDigest, setMaintenanceReviewDigest] =
    useState<string>();
  const [mode, setMode] = useState<AssistanceMode>();
  const [readState, setReadState] = useState<"unknown" | "absent" | "present">(
    "unknown",
  );
  const [contextTitle, setContextTitle] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [uncertainWrite, setUncertainWrite] = useState(false);
  const modeReadGeneration = useRef(0);
  const flight = useRef(false);
  const failureFocus = useRef<HTMLElement | null>(null);
  const readGeneration = useRef(0);
  const alive = useRef(true);
  const validOwner = useRef(true);
  const identity = JSON.stringify([
    owner.identity,
    target.databaseId,
    target.taskId ?? null,
    source.identity.id,
    source.identity.version,
    source.identity.digest,
  ]);
  const ownerIdentity = useRef(identity);
  ownerIdentity.current = identity;
  const current = useCallback(
    () =>
      alive.current && validOwner.current && ownerIdentity.current === identity,
    [identity],
  );
  const maintenanceSource = source.components.some(
    (component) =>
      component.action.kind === AssistantNativeActionKind.TaskMaintenance,
  );
  const handoverSource = source.components.some(
    (component) =>
      component.action.kind === AssistantNativeActionKind.TaskHandover,
  );
  const key = contextDocumentsAttemptKey(
    owner.server?.id ?? "",
    owner.account?.id ?? "",
    owner.workspace.id,
    target.databaseId,
    target.taskId,
    maintenanceSource
      ? "taskMaintenance"
      : handoverSource
        ? "taskHandover"
        : undefined,
    initialMaintenanceRun?.run.id,
  );
  const sameSource =
    !attempt ||
    (attempt.input.identity.id === source.identity.id &&
      attempt.input.identity.version === source.identity.version &&
      attempt.input.identity.digest === source.identity.digest);
  const editingUnaccepted = Boolean(
    attempt?.reviewUnacceptedEdit && readState === "absent" && !outcome,
  );
  const descriptor = attempt
    ? editingUnaccepted && sameSource && sourceActive
      ? source
      : outcome?.acceptedDescriptor
    : sourceActive
      ? source
      : undefined;
  const documentReview = attempt
    ? attempt.product === "documentReview"
    : source.components.some(
        (component) =>
          component.action.kind ===
          AssistantNativeActionKind.RequestDocumentReview,
      );
  const taskHandover = attempt
    ? attempt.product === "taskHandover"
    : handoverSource;
  const taskMaintenance = attempt
    ? attempt.product === "taskMaintenance"
    : maintenanceSource;
  const sourceTask = documentReview || taskHandover || taskMaintenance;
  const validation = useAssistantFormValidation(descriptor, answers);
  const formId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const subscription = owner.server?.account$.subscribe((account) => {
      if (account?.id !== owner.account?.id) validOwner.current = false;
    });
    return () => subscription?.unsubscribe();
  }, [owner.server, owner.account?.id]);
  useEffect(() => {
    let active = true;
    const modeEpoch = ++modeReadGeneration.current;
    setMode(undefined);
    void preferences.getAssistance(owner.workspace.id, target.projectId).then(
      (value) => {
        if (active && current() && modeEpoch === modeReadGeneration.current)
          setMode(value.mode);
      },
      () => {
        if (active && current() && modeEpoch === modeReadGeneration.current)
          setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [preferences, owner.workspace.id, revision, current, target.projectId]);

  const accept = (value: ContextOutcome, input: ContextDocumentsAttempt) => {
    if (!current()) return;
    if (
      !matchesContextOutcome(
        value,
        input,
        owner.workspace.id,
        owner.account?.id,
        target,
      )
    ) {
      setOutcome(undefined);
      setPlan(undefined);
      setLoaded(false);
      throw new Error("Context preparation owner changed");
    }
    setUncertainWrite(false);
    setReadState("present");
    setLoaded(true);
    setOutcome(value);
    const prepared = documentsOutcome(value)
      ? (value.currentReview ?? value.acceptedPlan)
      : value.acceptedPlan;
    setPlan(prepared);
    setAnswers(
      Object.fromEntries(prepared.answers.map((a) => [a.input, a.value])),
    );
    ++modeReadGeneration.current;
    if (documentsOutcome(value)) setMode(value.assistance.mode);
  };
  // Only canonical null permits same-key replay. A stale/Gone read returns
  // undefined and cannot authorize a write.
  const read = async (
    saved: ContextDocumentsAttempt,
  ): Promise<ContextOutcome | null | undefined> => {
    const readEpoch = ++readGeneration.current;
    try {
      const response = await readNativeContextAttempt(
        owner.server!,
        owner.workspace.id,
        saved,
      );
      if (!current() || readEpoch !== readGeneration.current) return undefined;
      if (
        response.actorId !== owner.account?.id ||
        response.workspaceId !== owner.workspace.id
      ) {
        setOutcome(undefined);
        setPlan(undefined);
        setLoaded(false);
        throw new Error("Context preparation owner changed");
      }
      if (response.value === undefined)
        throw new Error("Context preparation unavailable");
      if (response.value) accept(response.value, saved);
      else {
        setReadState("absent");
        setLoaded(true);
        setOutcome(undefined);
        setPlan(undefined);
      }
      return response.value;
    } catch (error) {
      if (!current() || readEpoch !== readGeneration.current) return undefined;
      if (
        UserFriendlyError.fromAny(error).extensions?.code ===
        "MIX_ASSISTANT_RESULT_GONE"
      ) {
        setOutcome(undefined);
        setPlan(undefined);
        setLoaded(false);
        const gone: ContextDocumentsAttempt = { ...saved, gone: true };
        await saveContextDocumentsAttempt(state, key, gone);
        if (current()) {
          setAttempt(gone);
          setOutcome(undefined);
          setPlan(undefined);
          setLoaded(true);
        }
      } else {
        if (["forbidden", "missing"].includes(classifyDatabaseError(error))) {
          setOutcome(undefined);
          setPlan(undefined);
          setLoaded(false);
        }
        throw error;
      }
    }
    return undefined;
  };
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setReadState("unknown");
    setAttempt(undefined);
    setOutcome(undefined);
    setPlan(undefined);
    setFailed(false);
    setAnswers(visibleAssistantAnswers(source, {}, true));
    void (async () => {
      try {
        let saved = await readContextDocumentsAttempt(state, key);
        if (!saved && initialMaintenanceRun && active && current()) {
          const accepted = initialMaintenanceRun.acceptedPlan;
          // A Rule run is read-only recovery routing, never a manufactured start.
          saved = {
            product: "taskMaintenance",
            maintenanceRunId: initialMaintenanceRun.run.id,
            input: {
              workspaceId: owner.workspace.id,
              target: accepted.target,
              requestId: initialMaintenanceRun.requestId,
              identity: accepted.package,
              answers: assistantAnswerPayload(
                Object.fromEntries(
                  accepted.answers.map((a) => [a.input, a.value]),
                ),
              ),
              locale: accepted.locale,
              clientVersion: accepted.clientVersion,
              planDigest: accepted.planDigest,
            },
          };
          await saveContextDocumentsAttempt(state, key, saved);
        }
        if (!active || !current()) return;
        if (
          saved &&
          (saved.input.workspaceId !== owner.workspace.id ||
            saved.input.target.databaseId !== target.databaseId ||
            (saved.input.target.taskId ?? null) !== (target.taskId ?? null))
        )
          throw new Error("Invalid context preparation owner");
        setAttempt(saved);
        if (saved && !saved.gone) {
          // Reuse the authorized opener read only while the confirmed transport
          // is byte-identical; a concurrent replacement requires native readback.
          const seed =
            initialRead &&
            JSON.stringify(saved) === JSON.stringify(initialRead.attempt)
              ? initialRead.outcome
              : undefined;
          let value: ContextOutcome | null | undefined;
          if (seed && active && current()) {
            ++readGeneration.current;
            accept(seed, saved);
            value = seed;
          } else value = await readRef.current(saved);
          if (
            active &&
            current() &&
            value === null &&
            saved.reviewUnacceptedEdit &&
            saved.input.identity.id === source.identity.id &&
            saved.input.identity.version === source.identity.version &&
            saved.input.identity.digest === source.identity.digest &&
            sourceActiveRef.current
          )
            setAnswers(
              nativeTaskAnswersFromTransport(source, saved.input.answers),
            );
        }
        if (active && current()) setLoaded(true);
      } catch {
        if (active && current()) {
          setFailed(true);
          setLoaded(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    state,
    key,
    current,
    owner.workspace.id,
    target.databaseId,
    target.taskId,
    source,
    initialMaintenanceRun,
    initialRead,
  ]);
  useEffect(() => {
    if (!busy && current() && failureFocus.current) {
      const opener = failureFocus.current;
      failureFocus.current = null;
      (opener.isConnected ? opener : container)?.focus();
    }
  }, [busy, container, current]);
  const run = async (action: () => Promise<unknown>) => {
    if (flight.current || !current()) return;
    flight.current = true;
    const opener =
      document.activeElement instanceof HTMLElement &&
      !document.activeElement.closest('[role="dialog"]')
        ? document.activeElement
        : null;
    setBusy(true);
    setFailed(false);
    setUncertainWrite(false);
    try {
      await action();
    } catch {
      if (current()) {
        failureFocus.current = opener;
        setFailed(true);
      }
    } finally {
      flight.current = false;
      if (current()) setBusy(false);
    }
  };
  const apply = async (review = false) => {
    if (
      !loaded ||
      attempt?.gone ||
      outcome?.run ||
      !plan?.executionAvailable ||
      !descriptor
    )
      return;
    let saved = attempt;
    if (saved && editingUnaccepted) {
      const prior = await read(saved);
      if (!current() || prior !== null || !sameSource || !sourceActive) return;
      saved = {
        product: saved.product,
        input: {
          workspaceId: owner.workspace.id,
          target: { databaseId: target.databaseId, taskId: target.taskId },
          requestId: saved.input.requestId,
          identity: plan.package,
          answers: assistantAnswerPayload(
            Object.fromEntries(
              plan.answers.map((answer) => [answer.input, answer.value]),
            ),
          ),
          locale: plan.locale,
          clientVersion: plan.clientVersion,
          planDigest: plan.planDigest,
        },
      };
    }
    if (!saved)
      saved = {
        ...(documentReview
          ? { product: "documentReview" as const }
          : taskMaintenance
            ? { product: "taskMaintenance" as const }
            : taskHandover
              ? { product: "taskHandover" as const }
              : {}),
        input: {
          workspaceId: owner.workspace.id,
          target: { databaseId: target.databaseId, taskId: target.taskId },
          identity: plan.package,
          answers: assistantAnswerPayload(
            Object.fromEntries(plan.answers.map((a) => [a.input, a.value])),
          ),
          locale: plan.locale,
          clientVersion: plan.clientVersion,
          planDigest: plan.planDigest,
          requestId: crypto.randomUUID(),
        },
      };
    else if (
      review &&
      outcome &&
      documentsOutcome(outcome) &&
      outcome.currentReview
    )
      saved = {
        ...saved,
        input: {
          ...saved.input,
          admissionConfirmation: outcome.currentReview.planDigest,
        },
      };
    await send(saved);
  };
  const send = async (saved: ContextDocumentsAttempt) => {
    if (saved.maintenanceRunId) return;
    // Every RPC, including resume, follows a durable flush and an owner recheck.
    await saveContextDocumentsAttempt(state, key, saved);
    if (!current()) return;
    setAttempt(saved);
    setUncertainWrite(true);
    if (saved.product === "taskMaintenance") {
      const response = await owner.server!.gql({
        query: startTaskMaintenanceMutation,
        variables: { input: saved.input },
      });
      if (current()) {
        ++readGeneration.current;
        accept(response.startTaskMaintenance, saved);
      }
      return;
    }
    if (saved.product === "taskHandover") {
      const response = await owner.server!.gql({
        query: startTaskHandoverMutation,
        variables: { input: saved.input },
      });
      if (current()) {
        ++readGeneration.current;
        accept(response.startTaskHandover, saved);
      }
      return;
    }
    if (saved.product === "documentReview") {
      const response = await owner.server!.gql({
        query: startDocumentReviewMutation,
        variables: { input: saved.input },
      });
      if (current()) {
        ++readGeneration.current;
        accept(response.startDocumentReview, saved);
      }
      return;
    }
    const response = await owner.server!.gql({
      query: applyContextDocumentsMutation,
      variables: { input: saved.input },
    });
    if (current()) {
      ++readGeneration.current;
      accept(response.applyContextDocuments, saved);
    }
  };
  const resume = async (saved: ContextDocumentsAttempt) => {
    const receipt = await read(saved);
    if (!current()) return;
    if (receipt === null) {
      if (saved.maintenanceRunId) return;
      await send(saved);
      return;
    }
    if (receipt?.run) {
      if (!receipt.canRetry) return;
      if (maintenanceOutcome(receipt)) {
        await saveContextDocumentsAttempt(state, key, saved);
        if (!current()) return;
        setUncertainWrite(true);
        const response = await owner.server!.gql({
          query: retryTaskMaintenanceMutation,
          variables: { input: { runId: receipt.run.id } },
        });
        if (current()) {
          ++readGeneration.current;
          accept(response.retryTaskMaintenance, saved);
        }
        return;
      }
      if (handoverOutcome(receipt)) {
        await saveContextDocumentsAttempt(state, key, saved);
        if (!current()) return;
        setUncertainWrite(true);
        const response = await owner.server!.gql({
          query: retryTaskHandoverMutation,
          variables: { input: { runId: receipt.run.id } },
        });
        if (current()) {
          ++readGeneration.current;
          accept(response.retryTaskHandover, saved);
        }
        return;
      }
      if (reviewOutcome(receipt)) {
        await saveContextDocumentsAttempt(state, key, saved);
        if (!current()) return;
        setUncertainWrite(true);
        const response = await owner.server!.gql({
          query: retryDocumentReviewMutation,
          variables: { input: { runId: receipt.run.id } },
        });
        if (current()) {
          ++readGeneration.current;
          accept(response.retryDocumentReview, saved);
        }
        return;
      }
      await saveContextDocumentsAttempt(state, key, saved);
      if (!current()) return;
      setUncertainWrite(true);
      const response = await owner.server!.gql({
        query: retryContextDocumentsMutation,
        variables: {
          input: {
            workspaceId: owner.workspace.id,
            requestId: saved.input.requestId,
          },
        },
      });
      if (!current()) return;
      ++readGeneration.current;
      accept(response.retryContextDocuments, saved);
      return;
    }
    if (
      !receipt ||
      !documentsOutcome(receipt) ||
      (receipt.status === ProjectSetupStatus.Unavailable &&
        !receipt.currentReview &&
        !receipt.canRetry &&
        !receipt.canStop) ||
      receipt.placementComplete ||
      !receipt.acceptedDescriptor ||
      !receipt.acceptedPlan.executionAvailable ||
      ![ProjectSetupStatus.Pending, ProjectSetupStatus.Unavailable].includes(
        receipt.status,
      )
    )
      return;
    await send(saved);
  };

  const confirmCorrection = async (choice: TaskCorrectionOutcome) => {
    if (!attempt) return;
    const latest = await read(attempt);
    if (
      !current() ||
      !latest ||
      !maintenanceOutcome(latest) ||
      latest.confirmation ||
      (choice === TaskCorrectionOutcome.Apply
        ? !latest.canApply
        : !latest.canDecline)
    )
      return;
    const correction = {
      runId: latest.run.id,
      requestId: attempt.correction?.requestId ?? crypto.randomUUID(),
      waitId: latest.waitId,
      proposalDigest: latest.acceptedPlan.proposal.digest,
      outcome: choice,
    };
    if (
      correction.runId !== latest.run.id ||
      correction.waitId !== latest.waitId ||
      correction.proposalDigest !== latest.acceptedPlan.proposal.digest ||
      (attempt.correction &&
        (attempt.correction.runId !== correction.runId ||
          attempt.correction.waitId !== correction.waitId ||
          attempt.correction.proposalDigest !== correction.proposalDigest))
    )
      return;
    const saved = { ...attempt, correction };
    await saveContextDocumentsAttempt(state, key, saved);
    if (!current()) return;
    setAttempt(saved);
    setUncertainWrite(true);
    try {
      const response = await owner.server!.gql({
        query: confirmTaskCorrectionsMutation,
        variables: { input: correction },
      });
      if (!current()) return;
      ++readGeneration.current;
      accept(response.confirmTaskCorrections, saved);
    } catch (error) {
      // A concurrent accepted choice wins; local transport is never its outcome.
      const canonical = await read(saved);
      if (
        current() &&
        (!canonical ||
          !maintenanceOutcome(canonical) ||
          !canonical.confirmation)
      )
        throw error;
    }
  };

  const onAction = (action: AssistantActionFragmentFragment) => {
    if (
      action.action === AssistantActionKind.Cancel ||
      action.action === AssistantActionKind.Close
    ) {
      onClose();
      return;
    }
    if (
      action.action === AssistantActionKind.Check ||
      action.action === AssistantActionKind.Refresh
    ) {
      if (attempt) void run(() => read(attempt));
      return;
    }
    if (
      [
        AssistantActionKind.ApplyDocuments,
        AssistantActionKind.RequestDocumentReview,
        AssistantActionKind.StartTaskMaintenance,
        AssistantActionKind.StartTaskHandover,
      ].includes(action.action)
    )
      void run(() =>
        apply(
          outcome &&
            documentsOutcome(outcome) &&
            contextOutcome?.status === ProjectSetupStatus.ReReviewRequired,
        ),
      );
  };
  const navigation = useAssistantNavigation(
    descriptor,
    onAction,
    busy,
    validation.validate,
  );
  const act = (action: AssistantActionFragmentFragment, confirmed = false) => {
    if (!current() || busy) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (
      [
        AssistantActionKind.PrepareDocuments,
        AssistantActionKind.PrepareDocumentReview,
        AssistantActionKind.PrepareTaskMaintenance,
        AssistantActionKind.PrepareTaskHandover,
      ].includes(action.action) &&
      !confirmed
    ) {
      if (
        (attempt && !editingUnaccepted) ||
        !loaded ||
        !descriptor ||
        !validation.validate()
      )
        return;
      void run(async () => {
        if (taskMaintenance) {
          if (attempt) {
            const prior = await read(attempt);
            if (!current() || prior !== null) return;
          }
          const response = await owner.server!.gql({
            query: prepareTaskMaintenanceQuery,
            variables: {
              workspaceId: owner.workspace.id,
              input: {
                target: {
                  databaseId: target.databaseId,
                  taskId: target.taskId,
                },
                identity: descriptor.identity,
                answers: assistantAnswerPayload(
                  visibleAssistantAnswers(descriptor, answers),
                ),
                locale: t.language,
                clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
              },
            },
          });
          if (!current()) return;
          const prepared = response.workspace?.prepareTaskMaintenance;
          if (
            response.currentUser?.id !== owner.account?.id ||
            response.workspace?.id !== owner.workspace.id ||
            !prepared ||
            prepared.package.id !== descriptor.identity.id ||
            prepared.package.version !== descriptor.identity.version ||
            prepared.package.digest !== descriptor.identity.digest ||
            prepared.target.databaseId !== target.databaseId ||
            (prepared.target.taskId ?? null) !== (target.taskId ?? null)
          )
            throw new Error("Review preparation owner changed");
          setPlan(prepared);
          setAnswers(
            Object.fromEntries(
              prepared.answers.map((answer) => [answer.input, answer.value]),
            ),
          );
          navigation.act(action, false, opener);
          return;
        }
        if (taskHandover) {
          if (attempt) {
            const prior = await read(attempt);
            if (!current() || prior !== null) return;
          }
          const response = await owner.server!.gql({
            query: prepareTaskHandoverQuery,
            variables: {
              workspaceId: owner.workspace.id,
              input: {
                target: {
                  databaseId: target.databaseId,
                  taskId: target.taskId,
                },
                identity: descriptor.identity,
                answers: assistantAnswerPayload(
                  visibleAssistantAnswers(descriptor, answers),
                ),
                locale: t.language,
                clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
              },
            },
          });
          if (!current()) return;
          const prepared = response.workspace?.prepareTaskHandover;
          if (
            response.currentUser?.id !== owner.account?.id ||
            response.workspace?.id !== owner.workspace.id ||
            !prepared ||
            prepared.package.id !== descriptor.identity.id ||
            prepared.package.version !== descriptor.identity.version ||
            prepared.package.digest !== descriptor.identity.digest ||
            prepared.target.databaseId !== target.databaseId ||
            (prepared.target.taskId ?? null) !== (target.taskId ?? null)
          )
            throw new Error("Review preparation owner changed");
          setPlan(prepared);
          setAnswers(
            Object.fromEntries(
              prepared.answers.map((answer) => [answer.input, answer.value]),
            ),
          );
          navigation.act(action, false, opener);
          return;
        }
        if (documentReview) {
          if (attempt) {
            const prior = await read(attempt);
            if (!current() || prior !== null) return;
          }
          const response = await owner.server!.gql({
            query: prepareDocumentReviewQuery,
            variables: {
              workspaceId: owner.workspace.id,
              input: {
                target: {
                  databaseId: target.databaseId,
                  taskId: target.taskId,
                },
                identity: descriptor.identity,
                answers: assistantAnswerPayload(
                  visibleAssistantAnswers(descriptor, answers),
                ),
                locale: t.language,
                clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
              },
            },
          });
          if (!current()) return;
          const prepared = response.workspace?.prepareDocumentReview;
          if (
            response.currentUser?.id !== owner.account?.id ||
            response.workspace?.id !== owner.workspace.id ||
            !prepared ||
            prepared.package.id !== descriptor.identity.id ||
            prepared.package.version !== descriptor.identity.version ||
            prepared.package.digest !== descriptor.identity.digest ||
            prepared.target.databaseId !== target.databaseId ||
            (prepared.target.taskId ?? null) !== (target.taskId ?? null)
          )
            throw new Error("Review preparation owner changed");
          setPlan(prepared);
          setAnswers(
            Object.fromEntries(
              prepared.answers.map((answer) => [answer.input, answer.value]),
            ),
          );
          navigation.act(action, false, opener);
          return;
        }
        const response = await owner.server!.gql({
          query: prepareContextDocumentsQuery,
          variables: {
            workspaceId: owner.workspace.id,
            input: {
              target: { databaseId: target.databaseId, taskId: target.taskId },
              identity: descriptor.identity,
              answers: assistantAnswerPayload(
                visibleAssistantAnswers(descriptor, answers),
              ),
              locale: t.language,
              clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
            },
          },
        });
        if (!current()) return;
        if (
          response.currentUser?.id !== owner.account?.id ||
          response.workspace?.id !== owner.workspace.id ||
          !response.workspace.prepareContextDocuments
        )
          throw new Error("Context preparation unavailable");
        const prepared = response.workspace.prepareContextDocuments;
        if (
          prepared.plan.package.id !== descriptor.identity.id ||
          prepared.plan.package.version !== descriptor.identity.version ||
          prepared.plan.package.digest !== descriptor.identity.digest ||
          prepared.plan.target.databaseId !== target.databaseId ||
          (prepared.plan.target.taskId ?? null) !== (target.taskId ?? null)
        )
          throw new Error("Context preparation target changed");
        setContextTitle(
          prepared.context.taskTitle ?? prepared.context.containerTitle,
        );
        setPlan(prepared.plan);
        ++modeReadGeneration.current;
        setMode(prepared.assistance.mode);
        setAnswers(
          Object.fromEntries(
            prepared.plan.answers.map((a) => [a.input, a.value]),
          ),
        );
        navigation.act(action, false, opener);
      });
    } else navigation.act(action, confirmed, opener);
  };
  const nativeInput = projectCreationInputAdapter({
    t,
    regionalPreferences,
    folders,
    people: ({ input, value, disabled, onChange, error }) => (
      <FormRow
        data-assistant-input={input.id}
        tabIndex={-1}
        label={assistantText(input.label, t.language)}
        error={error}
        help={
          input.description
            ? assistantText(input.description, t.language)
            : undefined
        }
      >
        <MemberSelectorInline
          selected={value?.memberIds ?? []}
          readonly={disabled}
          placeholder={t["com.myoxus.database.cell.empty"]()}
          onChange={(memberIds) =>
            onChange(assistantValue(AssistantValueType.Members, { memberIds }))
          }
        />
      </FormRow>
    ),
  });
  const adapters: AssistantNativeAdapters = {
    input: (props) =>
      sourceTask
        ? (documentReviewInput(props) ?? nativeInput(props))
        : nativeInput(props),
    control: (control) =>
      control.kind === AssistantControlKind.TaskMaintenanceReview ? (
        plan && maintenancePlan(plan) ? (
          <TaskMaintenancePlan plan={plan} current={current} />
        ) : (
          <Loading />
        )
      ) : control.kind === AssistantControlKind.TaskHandoverReview ? (
        plan && handoverPlan(plan) ? (
          <Stack>
            <DocumentTaskPlan
              plan={plan}
              onOpenSource={() => {
                if (current())
                  workbench.openDoc(plan.sourceExternalId, { at: "tail" });
              }}
            />
            <TaskReferencesInput references={plan.prerequisites} disabled />
          </Stack>
        ) : (
          <Loading />
        )
      ) : control.kind === AssistantControlKind.DocumentReview ? (
        plan && reviewPlan(plan) ? (
          <DocumentTaskPlan
            plan={plan}
            onOpenSource={() => {
              if (current())
                workbench.openDoc(plan.sourceExternalId, { at: "tail" });
            }}
          />
        ) : (
          <Stack data-testid="context-documents-review">
            {plan && !plan.executionAvailable ? (
              <Notice tone="warning">
                {t["com.myoxus.database.setup.status.unavailable"]()}
              </Notice>
            ) : null}
            {contextTitle ? <MyoxusText>{contextTitle}</MyoxusText> : null}
            <Table>
              <TableBody>
                {plan && documentsPlan(plan)
                  ? plan.documents.map((doc) => (
                      <TableRow key={doc.source.componentId}>
                        <TableCell>{doc.title}</TableCell>
                        <TableCell>{doc.locale}</TableCell>
                        <TableCell>
                          {doc.folder.name ??
                            folders.find(
                              (folder) => folder.value === doc.folder.id,
                            )?.label ??
                            t["com.myoxus.database.cell.empty"]()}
                        </TableCell>
                      </TableRow>
                    ))
                  : null}
              </TableBody>
            </Table>
            {descriptor && plan ? (
              <AssistantGroups
                descriptor={descriptor}
                groups={descriptor.presentation.steps
                  .flatMap((step) => step.groups)
                  .map((group) => ({
                    ...group,
                    controls: group.controls.filter(
                      (item) => item.kind === AssistantControlKind.Input,
                    ),
                  }))}
                answers={Object.fromEntries(
                  plan.answers.map((a) => [a.input, a.value]),
                )}
                disabled
                adapters={{ input: nativeInput }}
              />
            ) : null}
          </Stack>
        )
      ) : undefined,
  };
  const formAction = assistantFormAction(
    navigation.step?.actions ?? [],
    answers,
  );
  const nativeActionLabel = (kind: AssistantActionKind, fallback: string) => {
    const action =
      descriptor &&
      [...descriptor.presentation.steps, ...descriptor.presentation.dialogs]
        .flatMap((section) => section.actions)
        .find((action) => action.action === kind);
    return action ? assistantActionLabel(action, t) : fallback;
  };
  const locked = Boolean(attempt && !editingUnaccepted) || busy || !loaded;
  const contextOutcome =
    outcome && documentsOutcome(outcome) ? outcome : undefined;
  const status = attempt?.gone
    ? "gone"
    : contextOutcome?.status === ProjectSetupStatus.Ready
      ? "ready"
      : contextOutcome?.status === ProjectSetupStatus.Stopped
        ? "stopped"
        : contextOutcome?.status === ProjectSetupStatus.StopRequested
          ? "stop-requested"
          : contextOutcome?.status === ProjectSetupStatus.ReReviewRequired
            ? "review"
            : contextOutcome?.status === ProjectSetupStatus.Unavailable
              ? "unavailable"
              : outcome
                ? "pending"
                : "unknown";
  const statusCopy = {
    gone: t["com.myoxus.database.setup.status.gone"](),
    ready: t["com.myoxus.database.setup.status.ready"](),
    stopped: t["com.myoxus.database.setup.status.stopped"](),
    "stop-requested": t["com.myoxus.database.setup.status.stop-requested"](),
    review: t["com.myoxus.database.setup.status.review"](),
    unavailable: t["com.myoxus.database.setup.status.unavailable"](),
    pending: t["com.myoxus.database.setup.status.pending"](),
    unknown: t["com.myoxus.database.setup.status.unknown"](),
  };
  const legacyUnavailable = Boolean(
    outcome &&
    !outcome.run &&
    contextOutcome?.status === ProjectSetupStatus.Unavailable &&
    !contextOutcome?.currentReview &&
    !outcome.canRetry &&
    !outcome.canStop,
  );
  const activeRun =
    outcome?.run &&
    [
      WorkspaceAutomationRunStatus.Queued,
      WorkspaceAutomationRunStatus.Running,
    ].includes(outcome.run.status);
  const terminalRun =
    outcome?.run &&
    [
      WorkspaceAutomationRunStatus.Failed,
      WorkspaceAutomationRunStatus.DeadLetter,
      WorkspaceAutomationRunStatus.Skipped,
      WorkspaceAutomationRunStatus.Succeeded,
    ].includes(outcome.run.status);
  const canStartNew =
    attempt?.gone ||
    Boolean(
      loaded &&
      !failed &&
      !uncertainWrite &&
      outcome &&
      !activeRun &&
      !outcome.canRetry &&
      (contextOutcome?.status === ProjectSetupStatus.Stopped ||
        contextOutcome?.status === ProjectSetupStatus.Ready ||
        (contextOutcome?.status === ProjectSetupStatus.Unavailable &&
          contextOutcome?.placementComplete) ||
        terminalRun ||
        legacyUnavailable),
    );
  const failedOutcomeUnknown = Boolean(
    uncertainWrite ||
    (attempt && !outcome && !attempt.gone && readState !== "absent"),
  );
  const recoveryStatusVisible =
    !sourceTask && !(failed && failedOutcomeUnknown && status === "unknown");
  const titleInput = descriptor?.inputs.find(
    (input) => input.target === AssistantInputTarget.Title,
  );
  return (
    <>
      {container
        ? createPortal(
            <Stack data-testid="context-document-assistance">
              <MyoxusText>
                {descriptor
                  ? assistantText(descriptor.name, t.language)
                  : t["com.myoxus.assistance.title"]()}
              </MyoxusText>
              {target.title ? <MyoxusText>{target.title}</MyoxusText> : null}
              {failed ? (
                <Notice tone="warning">
                  {failedOutcomeUnknown
                    ? t["com.myoxus.database.setup.status.unknown"]()
                    : t["com.myoxus.common.operation-failed"]()}
                  <Button
                    onClick={() =>
                      void run(async () => {
                        const saved = await readContextDocumentsAttempt(
                          state,
                          key,
                        );
                        if (!current()) return;
                        setAttempt(saved);
                        if (saved && !saved.gone) await read(saved);
                        if (!saved) {
                          const modeEpoch = ++modeReadGeneration.current;
                          const confirmed = await preferences.getAssistance(
                            owner.workspace.id,
                            target.projectId,
                          );
                          if (
                            current() &&
                            modeEpoch === modeReadGeneration.current
                          )
                            setMode(confirmed.mode);
                        }
                        if (current()) setLoaded(true);
                      })
                    }
                  >
                    {t.Retry()}
                  </Button>
                </Notice>
              ) : null}
              {!loaded && !failed ? <Loading /> : null}
              {editingUnaccepted && !descriptor ? (
                <Notice tone="warning">
                  {t["com.myoxus.database.setup.status.unavailable"]()}
                </Notice>
              ) : null}
              {(!attempt || editingUnaccepted) &&
              mode === AssistanceMode.Guided &&
              titleInput &&
              target.title ? (
                <Button
                  variant="secondary"
                  disabled={locked}
                  data-testid="context-assistance-use-title"
                  onClick={() => {
                    setAnswers((previous) => ({
                      ...previous,
                      [titleInput.id]: assistantValue(AssistantValueType.Text, {
                        text: target.title,
                      }),
                    }));
                    setPlan(undefined);
                  }}
                >
                  {t["com.myoxus.assistance.use-context-title"]({
                    title: target.title,
                  })}
                </Button>
              ) : null}
              {(!attempt || editingUnaccepted) &&
              descriptor &&
              navigation.step ? (
                <form
                  id={formId}
                  ref={validation.formRef}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (formAction) act(formAction);
                  }}
                >
                  <AssistantGroups
                    descriptor={descriptor}
                    groups={navigation.step.groups}
                    stepId={navigation.step.id}
                    artworkServer={owner.server}
                    answers={answers}
                    disabled={locked}
                    invalidInputs={validation.invalidInputs}
                    adapters={adapters}
                    onAnswer={(input, value) => {
                      setAnswers((previous) => {
                        const next = { ...previous };
                        if (value) next[input.id] = value;
                        else delete next[input.id];
                        return next;
                      });
                      setPlan(undefined);
                    }}
                  />
                  <AssistantActions
                    actions={navigation.step.actions}
                    answers={answers}
                    busy={busy}
                    submitActionId={formAction?.id}
                    formId={formId}
                    onAction={act}
                    disabled={(action) =>
                      action.action === AssistantActionKind.Check ||
                      action.action === AssistantActionKind.Refresh ||
                      (!loaded &&
                        action.action !== AssistantActionKind.Close &&
                        action.action !== AssistantActionKind.Cancel)
                    }
                  />
                </form>
              ) : null}
              {attempt && !editingUnaccepted ? (
                <Stack data-testid="context-documents-recovery">
                  {recoveryStatusVisible ? (
                    <Notice>{statusCopy[status]}</Notice>
                  ) : null}
                  {outcome?.run ? (
                    <Badge
                      data-testid="context-documents-run-status"
                      tone={workspaceAutomationRunTone(outcome.run.status)}
                    >
                      {workspaceAutomationRunStatusLabel(t, outcome.run.status)}
                    </Badge>
                  ) : null}
                  {!descriptor && !attempt.gone ? (
                    <Notice tone="warning">
                      {t["com.myoxus.database.setup.status.unavailable"]()}
                    </Notice>
                  ) : null}
                  {outcome && maintenanceOutcome(outcome) ? (
                    <Stack>
                      <TaskMaintenancePlan
                        plan={outcome.acceptedPlan}
                        current={current}
                        onReady={setMaintenanceReviewDigest}
                      />
                      {outcome.reasonCode ? (
                        <Notice tone="warning">
                          {t["com.myoxus.database.setup.status.unavailable"]()}
                        </Notice>
                      ) : null}
                      {outcome.confirmation ? (
                        <Notice>
                          {outcome.confirmation.outcome ===
                          TaskCorrectionOutcome.Apply
                            ? t["com.myoxus.database.maintenance.confirmed"]()
                            : t["com.myoxus.database.maintenance.declined"]()}
                        </Notice>
                      ) : null}
                      {!outcome.confirmation ? (
                        <Group>
                          {[
                            TaskCorrectionOutcome.Apply,
                            TaskCorrectionOutcome.Decline,
                          ].map((choice) => (
                            <Button
                              key={choice}
                              disabled={
                                busy ||
                                (choice === TaskCorrectionOutcome.Apply
                                  ? !outcome.canApply ||
                                    maintenanceReviewDigest !==
                                      outcome.acceptedPlan.proposal.digest
                                  : !outcome.canDecline)
                              }
                              onClick={() =>
                                void run(() => confirmCorrection(choice))
                              }
                            >
                              {choice === TaskCorrectionOutcome.Apply
                                ? t.Apply()
                                : t[
                                    "com.myoxus.database.maintenance.decline"
                                  ]()}
                            </Button>
                          ))}
                        </Group>
                      ) : null}
                    </Stack>
                  ) : null}
                  {outcome && reviewOutcome(outcome) ? (
                    <>
                      {outcome.reasonCode ? (
                        <Notice tone="warning">
                          {t["com.myoxus.database.setup.status.unavailable"]()}
                        </Notice>
                      ) : null}
                      <DocumentTaskPlan
                        plan={outcome.acceptedPlan}
                        sourceAvailable={outcome.sourceAvailable}
                        onOpenSource={() => {
                          if (current() && outcome.sourceAvailable)
                            workbench.openDoc(
                              outcome.acceptedPlan.sourceExternalId,
                              { at: "tail" },
                            );
                        }}
                      />
                      <DocumentReviewResults
                        view={outcome}
                        current={current}
                        showSource={false}
                      />
                    </>
                  ) : null}
                  {outcome && handoverOutcome(outcome) ? (
                    <Stack>
                      {outcome.reasonCode ? (
                        <Notice tone="warning">
                          {t["com.myoxus.database.setup.status.unavailable"]()}
                        </Notice>
                      ) : null}
                      <DocumentTaskPlan
                        plan={outcome.acceptedPlan}
                        sourceAvailable={outcome.sourceAvailable}
                        onOpenSource={() => {
                          if (current() && outcome.sourceAvailable)
                            workbench.openDoc(
                              outcome.acceptedPlan.sourceExternalId,
                              { at: "tail" },
                            );
                        }}
                      />
                      <TaskHandoverProgress view={outcome} current={current} />
                      <TaskHandoverResults view={outcome} current={current} />
                    </Stack>
                  ) : null}
                  {contextOutcome?.documents
                    .filter((doc) => doc.created && doc.externalId)
                    .map((doc) => (
                      <Button
                        key={doc.componentId}
                        onClick={() => {
                          if (current())
                            workbench.openDoc(doc.externalId!, { at: "tail" });
                        }}
                      >
                        {(
                          contextOutcome.currentReview ??
                          contextOutcome.acceptedPlan
                        ).documents.find(
                          (plan) => plan.source.componentId === doc.componentId,
                        )?.title ?? t["com.myoxus.rootAppSidebar.library"]()}
                      </Button>
                    ))}
                  {contextOutcome?.status ===
                    ProjectSetupStatus.ReReviewRequired && descriptor ? (
                    <AssistantGroups
                      descriptor={descriptor}
                      groups={descriptor.presentation.dialogs.flatMap(
                        (dialog) => dialog.groups,
                      )}
                      answers={answers}
                      disabled
                      adapters={adapters}
                    />
                  ) : null}
                  <Group>
                    {sourceTask &&
                    !attempt.maintenanceRunId &&
                    readState === "absent" &&
                    !outcome &&
                    !attempt.gone ? (
                      <Button
                        disabled={
                          busy || !loaded || !sameSource || !sourceActive
                        }
                        onClick={() =>
                          void run(async () => {
                            const prior = await read(attempt);
                            if (
                              !current() ||
                              prior !== null ||
                              !sameSource ||
                              !sourceActive
                            )
                              return;
                            const restored = nativeTaskAnswersFromTransport(
                              source,
                              attempt.input.answers,
                            );
                            const editable: ContextDocumentsAttempt = {
                              ...attempt,
                              reviewUnacceptedEdit: true,
                            };
                            await saveContextDocumentsAttempt(
                              state,
                              key,
                              editable,
                            );
                            if (!current()) return;
                            setAttempt(editable);
                            setAnswers(restored);
                            setPlan(undefined);
                            validation.reset();
                          })
                        }
                      >
                        {t["com.myoxus.database.review.edit-unaccepted"]()}
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy || attempt.gone || (!loaded && !failed)}
                      onClick={() => void run(() => read(attempt))}
                    >
                      {nativeActionLabel(
                        AssistantActionKind.Check,
                        t["com.myoxus.database.setup.check"](),
                      )}
                    </Button>
                    {!attempt.gone &&
                    (((!attempt.correction ||
                      (outcome &&
                        maintenanceOutcome(outcome) &&
                        outcome.confirmation)) &&
                      outcome?.canRetry) ||
                      (!outcome?.run &&
                        !contextOutcome?.placementComplete &&
                        !legacyUnavailable &&
                        ![
                          ProjectSetupStatus.Ready,
                          ProjectSetupStatus.Stopped,
                          ProjectSetupStatus.StopRequested,
                        ].includes(
                          contextOutcome?.status ?? ProjectSetupStatus.Pending,
                        ))) ? (
                      <Button
                        disabled={
                          busy ||
                          !loaded ||
                          (!outcome?.run &&
                            readState !== "absent" &&
                            (!descriptor || !plan?.executionAvailable))
                        }
                        onClick={() => void run(() => resume(attempt))}
                      >
                        {outcome?.canRetry
                          ? t.Retry()
                          : t["com.myoxus.database.setup.resume"]()}
                      </Button>
                    ) : null}
                    {contextOutcome?.status ===
                      ProjectSetupStatus.ReReviewRequired &&
                    !contextOutcome.run ? (
                      <Button
                        disabled={
                          busy || !descriptor || !plan?.executionAvailable
                        }
                        onClick={() => void run(() => apply(true))}
                      >
                        {nativeActionLabel(
                          AssistantActionKind.ApplyDocuments,
                          t.Create(),
                        )}
                      </Button>
                    ) : null}
                    {outcome?.canStop ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const latest = await read(attempt);
                            if (!current() || !latest?.canStop) return;
                            await saveContextDocumentsAttempt(
                              state,
                              key,
                              attempt,
                            );
                            if (!current()) return;
                            setUncertainWrite(true);
                            if (maintenanceOutcome(latest)) {
                              const response = await owner.server!.gql({
                                query: stopTaskMaintenanceMutation,
                                variables: { input: { runId: latest.run.id } },
                              });
                              if (current()) {
                                ++readGeneration.current;
                                accept(response.stopTaskMaintenance, attempt);
                              }
                              return;
                            }
                            if (handoverOutcome(latest)) {
                              const response = await owner.server!.gql({
                                query: stopTaskHandoverMutation,
                                variables: { input: { runId: latest.run.id } },
                              });
                              if (current()) {
                                ++readGeneration.current;
                                accept(response.stopTaskHandover, attempt);
                              }
                              return;
                            }
                            if (reviewOutcome(latest)) {
                              const response = await owner.server!.gql({
                                query: stopDocumentReviewMutation,
                                variables: { input: { runId: latest.run.id } },
                              });
                              if (current()) {
                                ++readGeneration.current;
                                accept(response.stopDocumentReview, attempt);
                              }
                              return;
                            }
                            const response = await owner.server!.gql({
                              query: stopContextDocumentsMutation,
                              variables: {
                                input: {
                                  workspaceId: owner.workspace.id,
                                  requestId: attempt.input.requestId,
                                },
                              },
                            });
                            if (!current()) return;
                            if (!response.stopContextDocuments)
                              throw new Error("Missing context preparation");
                            ++readGeneration.current;
                            accept(response.stopContextDocuments, attempt);
                          })
                        }
                      >
                        {t["com.myoxus.database.setup.stop"]()}
                      </Button>
                    ) : null}
                    {canStartNew &&
                    sourceActive &&
                    !attempt.maintenanceRunId ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await saveContextDocumentsAttempt(
                              state,
                              key,
                              undefined,
                            );
                            if (!current()) return;
                            setAttempt(undefined);
                            setOutcome(undefined);
                            setPlan(undefined);
                            setAnswers(
                              visibleAssistantAnswers(source, {}, true),
                            );
                            validation.reset();
                          })
                        }
                      >
                        {taskHandover
                          ? t["com.myoxus.database.handover.new"]()
                          : documentReview
                            ? t["com.myoxus.database.review.new"]()
                            : t["com.myoxus.database.setup.new"]()}
                      </Button>
                    ) : null}
                    <Button disabled={busy} onClick={onClose}>
                      {nativeActionLabel(
                        AssistantActionKind.Close,
                        t["com.myoxus.peek-view-controls.close"](),
                      )}
                    </Button>
                  </Group>
                </Stack>
              ) : null}
            </Stack>,
            container,
          )
        : null}
      {descriptor && navigation.dialog ? (
        <AssistantNativeDialog
          descriptor={descriptor}
          dialog={navigation.dialog}
          dialogRef={validation.dialogRef}
          answers={answers}
          adapters={adapters}
          disabled={busy}
          busy={busy}
          invalidInputs={validation.invalidInputs}
          onClose={navigation.closeDialog}
          onAction={(action) => act(action, true)}
          actionDisabled={(action) =>
            [
              AssistantActionKind.ApplyDocuments,
              AssistantActionKind.RequestDocumentReview,
              AssistantActionKind.StartTaskMaintenance,
              AssistantActionKind.StartTaskHandover,
            ].includes(action.action) &&
            (Boolean(outcome?.run) || !plan?.executionAvailable || busy)
          }
        />
      ) : null}
    </>
  );
}
