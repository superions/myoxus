// SPDX-License-Identifier: AGPL-3.0-or-later

import { useService } from "@myoxus/infra";
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { SavedSetupControls } from "@myoxus/core/modules/database/presentation/saved-setup-controls";
import {
  useSavedSetup,
  savedSetupAnswers,
  savedSetupDescriptor,
} from "@myoxus/core/modules/database/presentation/use-saved-setup";
import { assistantLibrarySourcePath } from "@myoxus/core/modules/template-doc/view/catalog-model";
import { classifyDatabaseError } from "@myoxus/core/modules/database/route-state";
import { useTaskIdentity } from "@myoxus/core/modules/database/tasks/use-workspace-tasks";
import {
  AssistantActions,
  AssistantGroups,
} from "@myoxus/core/modules/database/presentation/renderer";
import {
  assistantAnswerPayload,
  assistantInputIsPlaced,
  assistantRequiredInputIds,
  assistantVisible,
  assistantValuesEqual,
  assistantText,
  assistantValue,
  resolvedAssistantValue,
  visibleAssistantAnswers,
  pruneAssistantDraft,
  type AssistantAnswers,
} from "@myoxus/core/modules/database/presentation/values";
import {
  assistantPackagesQuery,
  prepareProjectAssistantQuery,
  projectSetupQuery,
  stopProjectSetupMutation,
  ProjectSetupStatus,
  AssistantActionKind,
  AssistantContext,
  AssistantControlKind,
  AssistantInputTarget,
  AssistantValueType,
  type AssistantActionFragmentFragment as AssistantActionFragment,
  type AssistantControlFragmentFragment as AssistantControlFragment,
  type AssistantPackageFragmentFragment as AssistantPackageFragment,
  type QueryResponse,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { UserFriendlyError } from "@myoxus/error";
import {
  Button,
  FormRow,
  Group,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import {
  GlobalState,
  writeGlobalStateConfirmed,
} from "@myoxus/core/modules/storage";
import { TEMPLATE_SUGGESTION_CLIENT_VERSION } from "@myoxus/core/modules/template-doc/services/template-doc";
import {
  projectSetupAttemptKey,
  readProjectSetupAttempt,
  saveProjectSetupAttempt,
  type ProjectSetupAttempt,
} from "./project-setup-attempt";
import {
  ProjectCreationForm,
  ProjectCreationOfferings,
  ProjectCreationGroups,
  ProjectCreationPlanReview,
  projectCreationInputAdapter,
} from "./project-creation-form";
import type { DatabaseCreationAssistantProps } from "./creation-assistant";

type Prepared = NonNullable<
  NonNullable<
    QueryResponse<typeof prepareProjectAssistantQuery>["workspace"]
  >["prepareProjectAssistant"]
>;
const EMPTY_PACKAGES: AssistantPackageFragment[] = [];

type Setup = NonNullable<
  NonNullable<
    QueryResponse<typeof projectSetupQuery>["workspace"]
  >["projectSetup"]
>;

function initialProjectAnswers(
  descriptor: AssistantPackageFragment,
  defaultTitle: string,
  initialStructurePreset: DatabaseCreationAssistantProps["initialStructurePreset"],
) {
  const values = { ...visibleAssistantAnswers(descriptor, {}, true) };
  const title = descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.Title,
  );
  // Shared native creation intent applies only in the absence of a file default.
  if (title && title.defaultValue === null)
    values[title.id] = assistantValue(AssistantValueType.Text, {
      text: defaultTitle,
    });
  if (initialStructurePreset) {
    const structure = descriptor.inputs.find(
      (input) => input.target === AssistantInputTarget.StructurePreset,
    );
    const choice = structure?.choices.find(
      (choice) =>
        // Native source enums use snake_case; GraphQL projects PascalCase.
        (choice.value.choice ?? choice.value.text)
          ?.replaceAll("_", "")
          .toLowerCase() === initialStructurePreset.toLowerCase(),
    );
    if (structure && choice)
      values[structure.id] = assistantValue(AssistantValueType.Choice, {
        choice: choice.id,
      });
  }
  return values;
}

export type ProjectCreationRetentionSlot = {
  current:
    | {
        owner: string;
        descriptor: AssistantPackageFragment | null;
        answers: AssistantAnswers;
        explicitTargets: readonly AssistantInputTarget[];
        stepId: string | null;
        prepared: Prepared | null;
      }
    | undefined;
};

export function ProjectCreationAssistant(
  props: DatabaseCreationAssistantProps,
) {
  const owner = useTaskIdentity();
  return props.open &&
    owner.identity &&
    owner.server &&
    owner.availability.status === "available" ? (
    <ProjectCreationSession key={owner.identity} {...props} owner={owner} />
  ) : null;
}

function ProjectCreationSession({
  owner,
  ...props
}: DatabaseCreationAssistantProps & {
  owner: ReturnType<typeof useTaskIdentity>;
}) {
  const workbench = useService(WorkbenchService).workbench;
  const storage = useService(GlobalState);
  const storageKey = projectSetupAttemptKey(
    owner.server!.id,
    owner.account!.id,
    owner.workspace.id,
  );
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const restored =
    props.projectRetention?.current?.owner === owner.identity
      ? props.projectRetention.current
      : undefined;
  const [descriptor, setDescriptor] = useState<AssistantPackageFragment | null>(
    restored?.descriptor ?? null,
  );
  const packageId = descriptor?.identity.id ?? null;
  const [answers, setAnswers] = useState<AssistantAnswers>(
    restored?.answers ?? {},
  );
  const [explicitTargets, setExplicitTargets] = useState<
    ReadonlySet<AssistantInputTarget>
  >(
    new Set(
      restored?.explicitTargets ??
        (props.initialStructurePreset
          ? [AssistantInputTarget.StructurePreset]
          : []),
    ),
  );
  const [stepId, setStepId] = useState<string | null>(restored?.stepId ?? null);
  const [search, setSearch] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(
    restored?.prepared ?? null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const [requiredFeedback, setRequiredFeedback] = useState(false);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const [retainedAttempt, setRetainedAttempt] = useState<ProjectSetupAttempt>();
  const retainedRef = useRef<ProjectSetupAttempt | undefined>(undefined);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [reading, setReading] = useState(true);
  const [storageFailed, setStorageFailed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const ownerValid = useRef(true);
  const generation = useRef(0);
  const submitting = useRef(false);
  const alive = useRef(true);
  const identity = owner.identity;
  const latestOwner = useTaskIdentity();
  const ownerRef = useRef(latestOwner.identity);
  ownerRef.current = latestOwner.identity;
  const current = useCallback(
    (attempt: number) =>
      alive.current &&
      ownerValid.current &&
      ownerRef.current === identity &&
      attempt === generation.current,
    [identity],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const subscription = owner.server!.account$.subscribe((account) => {
      if (account?.id !== owner.account!.id) ownerValid.current = false;
    });
    return () => subscription.unsubscribe();
  }, [owner.server, owner.account?.id]);
  const catalog = useSWR(
    props.open &&
      identity &&
      owner.server &&
      owner.availability.status === "available"
      ? ["project-assistant-packages", identity]
      : null,
    () =>
      owner.server!.gql({
        query: assistantPackagesQuery,
        variables: {
          workspaceId: owner.workspace.id,
          context: AssistantContext.ProjectCreation,
        },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const catalogDenied = Boolean(
    catalog.error &&
    ["forbidden", "missing"].includes(classifyDatabaseError(catalog.error)),
  );
  const packages = catalogDenied
    ? EMPTY_PACKAGES
    : (catalog.data?.workspace?.assistantPackages ?? EMPTY_PACKAGES);
  const packageAvailable = Boolean(
    descriptor &&
    packages.some(
      (item) =>
        item.identity.id === descriptor.identity.id &&
        item.identity.version === descriptor.identity.version &&
        item.identity.digest === descriptor.identity.digest,
    ),
  );
  const step =
    descriptor?.presentation.steps.find((item) => item.id === stepId) ??
    descriptor?.presentation.steps[0];
  const stepIndex =
    descriptor?.presentation.steps.findIndex((item) => item.id === step?.id) ??
    0;
  const nativeBusy = pending || props.creating || reviewing || reading;
  const saved = useSavedSetup(
    owner.server ?? undefined,
    AssistantContext.ProjectCreation,
    nativeBusy ||
      storageFailed ||
      Boolean(retainedAttempt) ||
      owner.availability.status !== "available",
  );
  const busy = nativeBusy || saved.busy;
  const locked =
    busy || storageFailed || !packageAvailable || Boolean(retainedAttempt);
  useEffect(() => {
    if (!props.open || packageId || !packages.length) return;
    const first = packages.find((item) =>
      item.defaultFor.includes(AssistantContext.ProjectCreation),
    );
    if (!first) return;
    setDescriptor(first);
    const values = initialProjectAnswers(
      first,
      t["com.myoxus.database.create.project-title"](),
      props.initialStructurePreset,
    );
    setAnswers(values);
    setStepId(first.presentation.steps[0]?.id ?? null);
  }, [props.open, props.initialStructurePreset, packageId, packages, t]);

  useEffect(() => {
    if (!props.projectRetention || !identity) return;
    if (retainedAttempt) {
      props.projectRetention.current = undefined;
      return;
    }
    props.projectRetention.current = {
      owner: identity,
      descriptor,
      answers,
      explicitTargets: [...explicitTargets],
      stepId,
      prepared,
    };
  }, [
    props.projectRetention,
    identity,
    retainedAttempt,
    descriptor,
    answers,
    explicitTargets,
    stepId,
    prepared,
  ]);

  const changeAnswers = (
    next: AssistantAnswers,
    target: AssistantInputTarget,
  ) => {
    if (!descriptor || locked) return;
    generation.current++;
    setAnswers(pruneAssistantDraft(descriptor, next));
    setExplicitTargets((previous) => new Set([...previous, target]));
    setPrepared(null);
    setFailure(false);
  };
  const choosePackage = (id: string) => {
    if (busy || retainedAttempt) return;
    const next = packages.find((item) => item.identity.id === id);
    if (!next) return;
    generation.current++;
    const values = initialProjectAnswers(
      next,
      t["com.myoxus.database.create.project-title"](),
      props.initialStructurePreset,
    );
    const carriedTargets = new Set<AssistantInputTarget>();
    // Preserve deliberate edits/entry context, never another package's defaults.
    for (const input of next.inputs) {
      // A repeated IncludeComponent target identifies distinct child selections;
      // another offering must review its own authored defaults independently.
      if (input.target === AssistantInputTarget.IncludeComponent) continue;
      const previous = descriptor?.inputs.find(
        (value) => value.target === input.target,
      );
      if (
        previous &&
        explicitTargets.has(input.target) &&
        input.valueType === previous.valueType &&
        assistantInputIsPlaced(descriptor!, previous, answers) &&
        assistantVisible(previous.visibleWhen, answers)
      ) {
        const value = answers[previous.id];
        if (!value) {
          delete values[input.id];
          carriedTargets.add(input.target);
          continue;
        }
        if (value.kind === AssistantValueType.Choice) {
          const resolved = resolvedAssistantValue(previous, answers);
          const choice = input.choices.find(
            (choice) =>
              resolved && assistantValuesEqual(choice.value, resolved),
          );
          if (choice) {
            values[input.id] = assistantValue(AssistantValueType.Choice, {
              choice: choice.id,
            });
            carriedTargets.add(input.target);
          }
        } else {
          values[input.id] = value;
          carriedTargets.add(input.target);
        }
      }
    }
    setDialogId(null);
    setDialogOpen(false);
    setDescriptor(next);
    setExplicitTargets(carriedTargets);
    setAnswers(pruneAssistantDraft(next, values));
    setRequiredFeedback(false);
    setPrepared(null);
    setFailure(false);
  };
  const prepare = async () => {
    if (!descriptor || !packageAvailable || busy || retainedAttempt)
      return null;
    const attempt = ++generation.current;
    setPending(true);
    setFailure(false);
    try {
      const response = await owner.server!.gql({
        query: prepareProjectAssistantQuery,
        variables: {
          workspaceId: owner.workspace.id,
          input: {
            locale: t.language,
            clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
            identity: descriptor.identity,
            answers: assistantAnswerPayload(
              visibleAssistantAnswers(descriptor, answers),
            ),
          },
        },
      });
      const plan = response.workspace?.prepareProjectAssistant;
      if (
        !plan ||
        response.currentUser?.id !== owner.account!.id ||
        response.workspace?.id !== owner.workspace.id
      )
        throw new Error("Project preparation unavailable");
      if (!current(attempt)) return null;
      setPrepared(plan);
      return plan;
    } catch {
      if (current(attempt)) setFailure(true);
      return null;
    } finally {
      if (current(attempt)) setPending(false);
    }
  };
  const descriptorForPlan = useCallback(
    (plan: Prepared | null) => {
      // Recovery copy belongs to the receipt-authorized source, never a current
      // offering with similar inputs. It is not added to the fresh catalog.
      const candidate = retainedAttempt
        ? setup?.acceptedDescriptor
        : descriptor;
      return plan &&
        candidate &&
        candidate.identity.id === plan.package.id &&
        candidate.identity.version === plan.package.version &&
        candidate.identity.digest === plan.package.digest
        ? candidate
        : null;
    },
    [retainedAttempt, setup?.acceptedDescriptor, descriptor],
  );
  const matchesPlanDescriptor = useCallback(
    (plan: Prepared | null) => Boolean(descriptorForPlan(plan)),
    [descriptorForPlan],
  );
  const { onComplete, onCreate, projectRetention } = props;
  const readOutcome = useCallback(
    async (attempt: ProjectSetupAttempt, generationId: number) => {
      const requestId = attempt.request.assistantConfirmation.requestId;
      let response: QueryResponse<typeof projectSetupQuery>;
      try {
        response = await owner.server!.gql({
          query: projectSetupQuery,
          variables: { workspaceId: owner.workspace.id, requestId },
        });
      } catch (error) {
        if (
          UserFriendlyError.fromAny(error).extensions?.code !==
          "MIX_ASSISTANT_RESULT_GONE"
        )
          throw error;
        if (!current(generationId)) return null;
        const gone: ProjectSetupAttempt = { ...attempt, gone: true };
        // A failed marker flush keeps the original conservative request frozen.
        await saveProjectSetupAttempt(storage, storageKey, gone);
        if (!current(generationId)) return null;
        retainedRef.current = gone;
        setRetainedAttempt(gone);
        setSetup(null);
        setFailure(false);
        setStorageFailed(false);
        return null;
      }
      if (!current(generationId)) return null;
      if (response.currentUser?.id !== owner.account!.id)
        throw new Error("Project setup owner changed");
      if (!response.workspace || response.workspace.id !== owner.workspace.id)
        throw new Error("Project setup workspace unavailable");
      const result = response.workspace.projectSetup;
      if (result && result.requestId !== requestId)
        throw new Error("Project setup request changed");
      setSetup(result);
      if (result?.status === ProjectSetupStatus.Ready && result.database) {
        // Receipt completion is authoritative. Storage cleanup cannot create again.
        await writeGlobalStateConfirmed(storage, storageKey, undefined);
        if (!current(generationId)) return null;
      }
      return result;
    },
    [
      owner.server,
      owner.workspace.id,
      owner.account?.id,
      current,
      storage,
      storageKey,
    ],
  );
  const loadAttempt = useCallback(async () => {
    const generationId = ++generation.current;
    setReading(true);
    setStorageFailed(false);
    try {
      const attempt = await readProjectSetupAttempt(storage, storageKey);
      if (!current(generationId)) return;
      retainedRef.current = attempt;
      setRetainedAttempt(attempt);
      if (attempt && !attempt.gone) await readOutcome(attempt, generationId);
      else if (attempt?.gone) setSetup(null);
    } catch {
      if (current(generationId)) {
        setFailure(true);
        setStorageFailed(true);
      }
    } finally {
      if (current(generationId)) setReading(false);
    }
  }, [storage, storageKey, current, readOutcome]);
  useEffect(() => {
    void loadAttempt();
  }, [loadAttempt]);

  const apply = useCallback(
    async (resume = false) => {
      if (submitting.current || busy || storageFailed) return;
      if (
        resume
          ? !retainedRef.current || retainedRef.current.gone
          : !descriptor || !prepared?.executionAvailable || locked
      )
        return;
      submitting.current = true;
      setPending(true);
      setFailure(false);
      const generationId = ++generation.current;
      try {
        let attempt = retainedRef.current;
        if (!attempt) {
          if (!prepared) return;
          const planAnswers = Object.fromEntries(
            prepared.answers.map(({ input, value }) => [input, value]),
          );
          attempt = {
            request: {
              templateId: prepared.templateId,
              title: prepared.title,
              description: prepared.description ?? "",
              includeSampleRows: prepared.includeSampleRows,
              priorityPreset: prepared.priority,
              complexityPreset: prepared.complexity,
              structurePreset: prepared.structure,
              folderId: null,
              assistantConfirmation: {
                identity: prepared.package,
                answers: assistantAnswerPayload(planAnswers),
                planDigest: prepared.planDigest,
                requestId: crypto.randomUUID(),
                locale: prepared.locale,
                clientVersion: prepared.clientVersion,
              },
            },
          };
        } else if (setup?.status === ProjectSetupStatus.ReReviewRequired) {
          if (
            !setup.currentReview?.executionAvailable ||
            !matchesPlanDescriptor(setup.currentReview)
          )
            return;
          // Refresh duplicated native creation arguments from the visible review;
          // the confirmation retains the original user/source fingerprint.
          const reviewed = setup.currentReview;
          attempt = {
            request: {
              ...attempt.request,
              templateId: reviewed.templateId,
              title: reviewed.title,
              description: reviewed.description ?? "",
              includeSampleRows: reviewed.includeSampleRows,
              priorityPreset: reviewed.priority,
              complexityPreset: reviewed.complexity,
              structurePreset: reviewed.structure,
              folderId: null,
              assistantConfirmation: {
                ...attempt.request.assistantConfirmation,
                admissionConfirmation: setup.currentReview.planDigest,
              },
            },
          };
        } else if (
          setup &&
          setup.status !== ProjectSetupStatus.Pending &&
          setup.status !== ProjectSetupStatus.Unavailable
        )
          return;
        retainedRef.current = attempt;
        setRetainedAttempt(attempt);
        // Even recovered native Main-memory arguments require a durable flush before every RPC.
        await saveProjectSetupAttempt(storage, storageKey, attempt);
        if (!current(generationId)) return;
        await onCreate(attempt.request);
        if (!current(generationId)) return;
        const result = await readOutcome(attempt, generationId);
        if (
          current(generationId) &&
          result?.status === ProjectSetupStatus.Ready &&
          result.database
        ) {
          if (projectRetention) projectRetention.current = undefined;
          onComplete(
            result.database.database.id,
            result.database.initialViewId,
            result.requestId,
          );
        }
      } catch {
        if (current(generationId)) setFailure(true);
      } finally {
        submitting.current = false;
        if (current(generationId)) setPending(false);
      }
    },
    [
      busy,
      storageFailed,
      descriptor,
      prepared,
      locked,
      setup,
      storage,
      storageKey,
      current,
      onCreate,
      onComplete,
      projectRetention,
      readOutcome,
      matchesPlanDescriptor,
    ],
  );
  const review = async () => {
    if (busy) return;
    if (!retainedRef.current) {
      await loadAttempt();
      return;
    }
    const generationId = ++generation.current;
    setReviewing(true);
    setFailure(false);
    try {
      await readOutcome(retainedRef.current, generationId);
    } catch {
      if (current(generationId)) {
        setFailure(true);
        setSetup(null);
      }
    } finally {
      if (current(generationId)) setReviewing(false);
    }
  };
  const stop = async () => {
    if (
      !retainedRef.current ||
      retainedRef.current.gone ||
      busy ||
      submitting.current
    )
      return;
    submitting.current = true;
    const generationId = ++generation.current;
    setPending(true);
    setFailure(false);
    try {
      const requestId =
        retainedRef.current.request.assistantConfirmation.requestId;
      const response = await owner.server!.gql({
        query: stopProjectSetupMutation,
        variables: { input: { workspaceId: owner.workspace.id, requestId } },
      });
      if (!current(generationId)) return;
      if (response.stopProjectSetup.requestId !== requestId)
        throw new Error("Project setup request changed");
      setSetup(response.stopProjectSetup);
    } catch {
      if (current(generationId)) setFailure(true);
    } finally {
      submitting.current = false;
      if (current(generationId)) setPending(false);
    }
  };
  const newSetup = async () => {
    if (
      busy ||
      (!retainedRef.current?.gone &&
        setup?.status !== ProjectSetupStatus.Stopped)
    )
      return;
    const generationId = ++generation.current;
    setPending(true);
    try {
      await writeGlobalStateConfirmed(storage, storageKey, undefined);
      if (!current(generationId)) return;
      retainedRef.current = undefined;
      setRetainedAttempt(undefined);
      setSetup(null);
      setPrepared(null);
      setFailure(false);
      setStorageFailed(false);
      setStepId(descriptor?.presentation.steps[0]?.id ?? null);
    } catch {
      if (current(generationId)) setFailure(true);
    } finally {
      if (current(generationId)) setPending(false);
    }
  };
  const missingInputs =
    descriptor && step
      ? assistantRequiredInputIds(descriptor, step.groups, answers)
      : [];
  const saveRequiredInputs = descriptor
    ? assistantRequiredInputIds(
        descriptor,
        descriptor.presentation.steps.flatMap((step) => step.groups),
        answers,
      )
    : [];
  const validateForm = () => {
    setRequiredFeedback(true);
    if (missingInputs.length) {
      const control = formRef.current?.querySelector<HTMLElement>(
        `[data-assistant-input="${CSS.escape(missingInputs[0])}"]`,
      );
      const focus = control?.matches("input,textarea,button,[role=combobox]")
        ? control
        : control?.querySelector<HTMLElement>(
            "input,textarea,button,[role=combobox]",
          );
      (focus ?? control)?.focus();
      formRef.current?.reportValidity();
      return false;
    }
    return Boolean(formRef.current?.reportValidity());
  };
  const run = async (action: AssistantActionFragment, confirmed = false) => {
    if (!descriptor || busy) return;
    if (
      confirmed &&
      (action.action === AssistantActionKind.Cancel ||
        action.action === AssistantActionKind.Close)
    ) {
      setDialogOpen(false);
      return;
    }
    if (action.dialog && !confirmed) {
      // Capture before prepare disables the trigger; native Modal owns return focus.
      dialogTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (action.action === AssistantActionKind.CreateProject) {
        if (!validateForm() || !(await prepare())) return;
      }
      setDialogId(action.dialog);
      setDialogOpen(true);
      return;
    }
    switch (action.action) {
      case AssistantActionKind.Cancel:
      case AssistantActionKind.Close:
        props.onOpenChange(false);
        return;
      case AssistantActionKind.Next:
      case AssistantActionKind.Back: {
        if (retainedAttempt) return;
        if (action.action === AssistantActionKind.Next && !validateForm())
          return;
        const direction = action.action === AssistantActionKind.Next ? 1 : -1;
        const next = action.targetStep
          ? descriptor.presentation.steps.find(
              (step) => step.id === action.targetStep,
            )
          : descriptor.presentation.steps[stepIndex + direction];
        if (!next) return;
        if (
          next.groups.some((group) =>
            group.controls.some(
              (control) => control.kind === AssistantControlKind.ProjectReview,
            ),
          ) &&
          !(await prepare())
        )
          return;
        setStepId(next.id);
        setRequiredFeedback(false);
        setDialogId(null);
        return;
      }
      case AssistantActionKind.CreateProject:
        if (!prepared) {
          if (!validateForm() || !(await prepare())) return;
          const review = descriptor.presentation.steps.find((step) =>
            step.groups.some((group) =>
              group.controls.some(
                (control) =>
                  control.kind === AssistantControlKind.ProjectReview,
              ),
            ),
          );
          if (review) setStepId(review.id);
          // Preparation never applies. The canonical review must be visible
          // before a separate explicit native confirmation can write.
          return;
        }
        setDialogId(null);
        await apply();
        return;
      case AssistantActionKind.Check:
        await review();
        return;
      case AssistantActionKind.Refresh:
        void catalog.mutate();
        return;
      default:
        return;
    }
  };
  const dialog = descriptor?.presentation.dialogs.find(
    (item) => item.id === dialogId,
  );
  const setupStatusLabel = (status: ProjectSetupStatus | undefined) => {
    switch (status) {
      case ProjectSetupStatus.Ready:
        return t["com.myoxus.database.setup.status.ready"]();
      case ProjectSetupStatus.Pending:
        return t["com.myoxus.database.setup.status.pending"]();
      case ProjectSetupStatus.StopRequested:
        return t["com.myoxus.database.setup.status.stop-requested"]();
      case ProjectSetupStatus.Stopped:
        return t["com.myoxus.database.setup.status.stopped"]();
      case ProjectSetupStatus.ReReviewRequired:
        return t["com.myoxus.database.setup.status.review"]();
      case ProjectSetupStatus.Unavailable:
        return t["com.myoxus.database.setup.status.unavailable"]();
      default:
        return t["com.myoxus.database.setup.status.unknown"]();
    }
  };
  const renderPlan = (plan: Prepared | null) => (
    <ProjectCreationPlanReview
      plan={plan}
      source={descriptorForPlan(plan)}
      folders={props.folders}
      regionalPreferences={regionalPreferences}
      people={(ids) => (
        <MemberSelectorInline
          selected={ids}
          readonly
          onChange={() => undefined}
        />
      )}
    />
  );
  const nativeControl = (control: AssistantControlFragment) => {
    if (control.kind === AssistantControlKind.OfferingSelection)
      return (
        <ProjectCreationOfferings
          packages={packages}
          packageId={packageId}
          available={packageAvailable}
          search={search}
          onSearch={setSearch}
          onSelect={choosePackage}
          disabled={busy || Boolean(retainedAttempt)}
          label={step ? assistantText(step.title, t.language) : undefined}
          searchable={control.search ?? false}
        />
      );
    if (control.kind === AssistantControlKind.ProjectReview)
      return renderPlan(prepared);
    return undefined;
  };
  const adapters: Parameters<typeof AssistantGroups>[0]["adapters"] = {
    control: nativeControl,
    input: projectCreationInputAdapter({
      t,
      regionalPreferences,
      folders: props.folders,
      people: ({ input, value, disabled, onChange, error }) => (
        <FormRow
          data-assistant-input={input.id}
          tabIndex={-1}
          label={assistantText(input.label, t.language)}
          help={
            input.description
              ? assistantText(input.description, t.language)
              : undefined
          }
          error={error}
        >
          <MemberSelectorInline
            selected={value?.memberIds ?? []}
            readonly={disabled}
            placeholder={t["com.myoxus.database.cell.empty"]()}
            onChange={(memberIds) =>
              onChange(
                assistantValue(AssistantValueType.Members, { memberIds }),
              )
            }
          />
        </FormRow>
      ),
    }),
  };
  const renderGroups = (
    groups: NonNullable<typeof step>["groups"],
    stepId?: string,
  ) =>
    descriptor ? (
      <ProjectCreationGroups
        invalidInputs={requiredFeedback ? new Set(missingInputs) : undefined}
        stepId={stepId}
        artworkServer={owner.server}
        onOpenDocumentSource={(source) => {
          if (!descriptor || locked || ownerRef.current !== identity) return;
          props.onOpenChange(false);
          workbench.open(
            assistantLibrarySourcePath({
              identity: descriptor.identity,
              step: source.step,
              group: source.group,
              sourceDigest: source.digest,
            }),
            // Keep the owning Database view mounted: it owns the retained draft.
            { at: "tail" },
          );
        }}
        groups={groups}
        descriptor={descriptor}
        answers={answers}
        disabled={locked}
        adapters={adapters}
        onAnswer={(input, value) => {
          const next = { ...answers };
          if (value) next[input.id] = value;
          else delete next[input.id];
          changeAnswers(next, input.target);
        }}
      />
    ) : null;
  return (
    <Modal
      open={props.open}
      title={
        retainedAttempt
          ? setup?.acceptedDescriptor
            ? assistantText(setup.acceptedDescriptor.name, t.language)
            : t["com.myoxus.database.create.project-dialog.title"]()
          : descriptor
            ? assistantText(descriptor.name, t.language)
            : t["com.myoxus.database.create.project-dialog.title"]()
      }
      persistent={busy}
      scrollable
      width="xl"
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
      contentOptions={{ "data-testid": "database-creation-assistant" }}
    >
      <Stack>
        {!retainedAttempt && (catalog.isLoading || reading) ? (
          <Loading />
        ) : retainedAttempt ? null : catalogDenied || !descriptor || !step ? (
          <Notice tone="warning">
            <Button onClick={() => void catalog.mutate()}>{t.Retry()}</Button>
          </Notice>
        ) : (
          <>
            <SavedSetupControls
              {...saved}
              disabled={locked}
              canSave={Boolean(
                descriptor && packageAvailable && !saveRequiredInputs.length,
              )}
              canLoad={!locked}
              onSave={() => {
                if (
                  !descriptor ||
                  locked ||
                  retainedRef.current ||
                  saveRequiredInputs.length > 0 ||
                  !validateForm()
                )
                  return;
                saved.save({
                  package: {
                    identity: descriptor.identity,
                    answers: assistantAnswerPayload(
                      visibleAssistantAnswers(descriptor, answers),
                    ),
                  },
                });
              }}
              onLoad={() =>
                saved.load(async (resolution) => {
                  const ownerGeneration = generation.current;
                  if (
                    retainedRef.current ||
                    submitting.current ||
                    !current(ownerGeneration)
                  )
                    return false;
                  const latest = await catalog.mutate();
                  if (
                    !current(ownerGeneration) ||
                    retainedRef.current ||
                    submitting.current ||
                    latest?.workspace?.id !== owner.workspace.id
                  )
                    return false;
                  const next = savedSetupDescriptor(
                    latest.workspace.assistantPackages,
                    resolution.package,
                  );
                  if (!next) return false;
                  ++generation.current;
                  setDescriptor(next);
                  setAnswers(savedSetupAnswers(next, resolution.package));
                  setExplicitTargets(new Set());
                  setStepId(next.presentation.steps[0]?.id ?? null);
                  setPrepared(null);
                  setDialogId(null);
                  setDialogOpen(false);
                  setRequiredFeedback(false);
                  setFailure(false);
                  return true;
                })
              }
            />
            <ProjectCreationForm
              descriptor={descriptor}
              stepId={step.id}
              formRef={formRef}
              formId={formId}
              answers={answers}
              busy={busy}
              renderGroups={renderGroups}
              onAction={(action) => void run(action)}
              actionDisabled={(action) =>
                action.action === AssistantActionKind.CreateProject &&
                (locked || Boolean(prepared && !prepared.executionAvailable))
              }
            >
              {!packageAvailable ? (
                <Notice tone="warning">
                  {t["com.myoxus.database.tasks.source-unavailable"]()}
                </Notice>
              ) : null}
              {prepared && !prepared.executionAvailable ? (
                <Notice tone="warning">
                  {t["com.myoxus.template-list.unavailable"]()}
                </Notice>
              ) : null}
              {failure ? (
                <Notice tone="error">
                  {t[
                    "com.myoxus.database.create.assistant.create-error.title"
                  ]()}
                </Notice>
              ) : null}
            </ProjectCreationForm>
          </>
        )}
        {failure && retainedAttempt ? (
          <Notice tone="error">
            {t["com.myoxus.database.create.assistant.create-error.title"]()}
          </Notice>
        ) : null}
        {retainedAttempt ? (
          <Stack data-testid="database-assistant-recovery">
            <Notice
              tone={
                setup?.status === ProjectSetupStatus.Ready ? "info" : "warning"
              }
            >
              {retainedAttempt.gone
                ? t["com.myoxus.database.setup.status.gone"]()
                : setupStatusLabel(setup?.status)}
            </Notice>
            <Group>
              <Button disabled={busy} onClick={() => props.onOpenChange(false)}>
                {t.Cancel()}
              </Button>
              <Button disabled={busy} onClick={() => void review()}>
                {t["com.myoxus.database.setup.check"]()}
              </Button>
              {!retainedAttempt.gone &&
              (!setup ||
                setup.status === ProjectSetupStatus.Pending ||
                setup.status === ProjectSetupStatus.Unavailable) ? (
                <Button
                  disabled={busy || storageFailed}
                  onClick={() => void apply(true)}
                >
                  {t["com.myoxus.database.setup.resume"]()}
                </Button>
              ) : null}
              {setup?.status === ProjectSetupStatus.ReReviewRequired ? (
                <Button
                  disabled={
                    busy ||
                    !setup.currentReview?.executionAvailable ||
                    !matchesPlanDescriptor(setup.currentReview)
                  }
                  onClick={() => void apply(true)}
                >
                  {t["com.myoxus.database.setup.confirm-review"]()}
                </Button>
              ) : null}
              {setup &&
              (setup.status === ProjectSetupStatus.Pending ||
                setup.status === ProjectSetupStatus.Unavailable ||
                setup.status === ProjectSetupStatus.ReReviewRequired) ? (
                <Button disabled={busy} onClick={() => void stop()}>
                  {t["com.myoxus.database.setup.stop"]()}
                </Button>
              ) : null}
              {retainedAttempt.gone ||
              setup?.status === ProjectSetupStatus.Stopped ? (
                <Button disabled={busy} onClick={() => void newSetup()}>
                  {t["com.myoxus.database.setup.new"]()}
                </Button>
              ) : null}
              {setup?.database ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    props.onComplete(
                      setup.database!.database.id,
                      setup.database!.initialViewId,
                      setup.requestId,
                    )
                  }
                >
                  {t["com.myoxus.database.tasks.open-project"]()}
                </Button>
              ) : null}
              {setup?.documents
                .filter((doc) => doc.created && doc.externalId)
                .map((doc) => (
                  <Button
                    key={doc.componentId}
                    disabled={busy}
                    onClick={() => {
                      if (doc.externalId)
                        workbench.openDoc(doc.externalId, { at: "tail" });
                    }}
                  >
                    {setup.acceptedPlan.documents.find(
                      (source) => source.source.componentId === doc.componentId,
                    )?.title ?? t["com.myoxus.database.embed.open"]()}
                  </Button>
                ))}
            </Group>
            {setup?.status === ProjectSetupStatus.ReReviewRequired &&
            setup.currentReview ? (
              <Stack data-testid="database-assistant-current-review">
                <MyoxusText>{setup.currentReview.title}</MyoxusText>
                {!matchesPlanDescriptor(setup.currentReview) ? (
                  <Notice tone="warning">
                    {t["com.myoxus.template-list.unavailable"]()}
                  </Notice>
                ) : null}
                {renderPlan(setup.currentReview)}
              </Stack>
            ) : null}
          </Stack>
        ) : storageFailed ? (
          <Button disabled={busy} onClick={() => void loadAttempt()}>
            {t["com.myoxus.database.setup.check"]()}
          </Button>
        ) : null}
      </Stack>
      {dialog ? (
        <Modal
          open={dialogOpen}
          returnFocusRef={dialogTrigger}
          title={assistantText(dialog.title, t.language)}
          persistent={busy}
          onOpenChange={(open) => {
            if (!open && !busy) setDialogOpen(false);
          }}
        >
          <Stack>
            {renderGroups(dialog.groups)}
            <AssistantActions
              actions={dialog.actions}
              answers={
                descriptor ? visibleAssistantAnswers(descriptor, answers) : {}
              }
              busy={busy}
              disabled={(action) =>
                action.action === AssistantActionKind.CreateProject &&
                (!prepared || !prepared.executionAvailable || locked)
              }
              onAction={(action) => void run(action, true)}
            />
          </Stack>
        </Modal>
      ) : null}
    </Modal>
  );
}
