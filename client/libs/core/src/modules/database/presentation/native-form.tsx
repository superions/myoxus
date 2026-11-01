// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AssistantActionKind,
  type AssistantActionFragmentFragment as AssistantActionFragment,
  type AssistantGroupFragmentFragment,
  type AssistantDialogFragmentFragment as AssistantDialogFragment,
  type AssistantPackageFragmentFragment as AssistantPackageFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Modal, Stack } from "@myoxus/ui-facade";
import { useRef, useState, type Ref, type RefObject } from "react";
import {
  AssistantActions,
  AssistantGroups,
  type AssistantNativeAdapters,
} from "./renderer";
import { assistantText, type AssistantAnswers } from "./values";

type AssistantDialogState = {
  definition: AssistantDialogFragment;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
};

/** Transient navigation only; native controllers own write and recovery state. */
export function useAssistantNavigation(
  descriptor: AssistantPackageFragment | null | undefined,
  onAction: (action: AssistantActionFragment) => void,
  busy: boolean,
  beforeNext?: (groups: readonly AssistantGroupFragmentFragment[]) => boolean,
) {
  const [stepId, setStepId] = useState<string | null>(null);
  const [dialogId, setDialogId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const steps = descriptor?.presentation.steps ?? [];
  const step = steps.find((step) => step.id === stepId) ?? steps[0];
  const index = steps.findIndex((item) => item.id === step?.id);
  const dialog = descriptor?.presentation.dialogs.find(
    (item) => item.id === dialogId,
  );
  const act = (
    action: AssistantActionFragment,
    confirmed = false,
    returnFocusTo?: HTMLElement | null,
  ) => {
    if (busy) return;
    if (
      confirmed &&
      (action.action === AssistantActionKind.Cancel ||
        action.action === AssistantActionKind.Close)
    ) {
      setDialogOpen(false);
      return;
    }
    if (action.dialog && !confirmed) {
      if (
        ![AssistantActionKind.Cancel, AssistantActionKind.Close].includes(
          action.action,
        ) &&
        step &&
        beforeNext &&
        !beforeNext(step.groups)
      )
        return;
      // Async preparation can disable the opener before the dialog is shown.
      // Its host may retain that actual element before awaiting the native plan.
      dialogTrigger.current =
        returnFocusTo ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      setDialogId(action.dialog);
      setDialogOpen(true);
      return;
    }
    if (
      action.action === AssistantActionKind.Next ||
      action.action === AssistantActionKind.Back
    ) {
      if (
        action.action === AssistantActionKind.Next &&
        step &&
        beforeNext &&
        !beforeNext(dialogOpen ? (dialog?.groups ?? step.groups) : step.groups)
      )
        return;
      const next = action.targetStep
        ? steps.find((item) => item.id === action.targetStep)
        : steps[index + (action.action === AssistantActionKind.Next ? 1 : -1)];
      if (next) setStepId(next.id);
      setDialogOpen(false);
    } else {
      // Validate before dismissing the portal so required feedback keeps its owner.
      if (
        [
          AssistantActionKind.CreateTask,
          AssistantActionKind.CaptureTask,
          AssistantActionKind.CreateSubtask,
          AssistantActionKind.PrepareTaskMove,
          AssistantActionKind.CommitTaskMove,
          AssistantActionKind.PrepareDocuments,
          AssistantActionKind.ApplyDocuments,
          AssistantActionKind.PrepareTaskMaintenance,
          AssistantActionKind.StartTaskMaintenance,
          AssistantActionKind.PrepareTaskHandover,
          AssistantActionKind.StartTaskHandover,
          AssistantActionKind.PrepareDocumentReview,
          AssistantActionKind.RequestDocumentReview,
        ].includes(action.action) &&
        beforeNext &&
        !beforeNext(
          [...steps, ...(descriptor?.presentation.dialogs ?? [])].flatMap(
            (item) => item.groups,
          ),
        )
      )
        return;
      setDialogOpen(false);
      onAction(action);
    }
  };
  return {
    step,
    index,
    // Keep the definition mounted through the native exit transition. Immediate
    // unmount would lose Modal's explicit focus return to the action opener.
    dialog: dialog
      ? { definition: dialog, open: dialogOpen, returnFocusRef: dialogTrigger }
      : undefined,
    act,
    closeDialog: () => {
      if (!busy) setDialogOpen(false);
    },
  };
}

export function AssistantNativeDialog({
  descriptor,
  dialog: state,
  answers,
  adapters,
  disabled,
  busy,
  onClose,
  onAction,
  actionDisabled,
  invalidInputs,
  dialogRef,
}: {
  descriptor: AssistantPackageFragment;
  dialog: AssistantDialogState;
  answers: AssistantAnswers;
  adapters: AssistantNativeAdapters;
  disabled: boolean;
  busy: boolean;
  onClose: () => void;
  onAction: (action: AssistantActionFragment) => void;
  actionDisabled?: (action: AssistantActionFragment) => boolean;
  invalidInputs?: ReadonlySet<string>;
  dialogRef?: Ref<HTMLDivElement>;
}) {
  const t = useI18n();
  const dialog = state.definition;
  return (
    <Modal
      open={state.open}
      returnFocusRef={state.returnFocusRef}
      persistent={busy}
      title={assistantText(dialog.title, t.language)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Stack ref={dialogRef}>
        <AssistantGroups
          descriptor={descriptor}
          groups={dialog.groups}
          answers={answers}
          adapters={adapters}
          disabled={disabled}
          invalidInputs={invalidInputs}
        />
        <AssistantActions
          actions={dialog.actions}
          answers={answers}
          busy={busy}
          disabled={
            actionDisabled ??
            ((action) =>
              disabled &&
              ![
                AssistantActionKind.Cancel,
                AssistantActionKind.Close,
                AssistantActionKind.Check,
                AssistantActionKind.Refresh,
                AssistantActionKind.OpenCurrentRow,
                AssistantActionKind.OpenRelatedRow,
              ].includes(action.action))
          }
          onAction={onAction}
        />
      </Stack>
    </Modal>
  );
}
