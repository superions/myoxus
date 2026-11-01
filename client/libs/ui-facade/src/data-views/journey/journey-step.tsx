// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Tooltip,
} from "@mantine/core";

import { MoreHorizontalIcon, TrashIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DragHandle } from "../../drag-handle";
import { DropIndicator } from "../../dnd/drop-indicator";
import { useDraggable } from "../../dnd/draggable";
import { useDropTarget } from "../../dnd/drop-target";

import { InlineEdit, type InlineEditHandle } from "../../inline-edit";

import type {
  JourneyMapStep,
  JourneyMapSection,
  JourneyMapStepMove,
  JourneyMapLabels,
  JourneyMapProps,
} from "./types";
import {
  wouldMoveJourneyStep,
  isJourneyActionTarget,
  type JourneyDndData,
  type JourneyKeyboardStepDrag,
} from "./journey-dnd";
export function JourneyStep({
  step,
  mapId,
  sectionIndex,
  sections,
  labels,
  renderLabel,
  readonly,
  selected,
  onInteractionStart,
  onEditInput,
  onEditEnd,
  onMoveStep,
  onOpenStep,
  onSelectStep,
  onRenameStep,
  onDeleteStep,
  editRequest,
  keyboardDrag,
  onKeyboardDragChange,
  announce,
}: {
  step: JourneyMapStep;
  mapId: string;
  sectionIndex: number;
  sections: ReadonlyArray<JourneyMapSection>;
  labels: JourneyMapLabels;
  renderLabel?: JourneyMapProps["renderLabel"];
  readonly: boolean;
  selected: boolean;
  onEditInput?: JourneyMapProps["onEditInput"];
  onInteractionStart?: JourneyMapProps["onInteractionStart"];
  onEditEnd?: JourneyMapProps["onEditEnd"];
  onMoveStep?: JourneyMapProps["onMoveStep"];
  onOpenStep?: JourneyMapProps["onOpenStep"];
  onSelectStep?: JourneyMapProps["onSelectStep"];
  onRenameStep?: JourneyMapProps["onRenameStep"];
  onDeleteStep?: JourneyMapProps["onDeleteStep"];
  editRequest?: JourneyMapProps["editRequest"];
  keyboardDrag: JourneyKeyboardStepDrag | null;
  onKeyboardDragChange: (drag: JourneyKeyboardStepDrag | null) => void;
  announce: (message: string) => void;
}) {
  const [interactionDisabled, setInteractionDisabled] = useState(false);
  const editHandleRef = useRef<InlineEditHandle>(null);
  const handledEditRequestRef = useRef<number | undefined>(undefined);
  const stepElementRef = useRef<HTMLDivElement | null>(null);

  const movable =
    !interactionDisabled &&
    !readonly &&
    step.move?.enabled !== false &&
    onMoveStep;
  const openable = step.open?.enabled !== false && onOpenStep;
  const removable =
    !readonly && step.remove?.enabled !== false && Boolean(onDeleteStep);
  const selectable = !interactionDisabled && Boolean(onSelectStep);
  const keyboardTarget = keyboardDrag?.stepId === step.id ? keyboardDrag : null;
  const keyboardDropEdge = useMemo(() => {
    if (!keyboardDrag || keyboardDrag.sectionIndex !== sectionIndex)
      return null;
    const targetSteps = sections[sectionIndex]?.steps.filter(
      (candidate) => candidate.id !== keyboardDrag.stepId,
    );
    if (!targetSteps?.length) return null;
    const targetIndex = targetSteps.findIndex(
      (candidate) => candidate.id === step.id,
    );
    if (targetIndex === keyboardDrag.insertionIndex) return "left";
    if (
      keyboardDrag.insertionIndex === targetSteps.length &&
      targetIndex === targetSteps.length - 1
    ) {
      return "right";
    }
    return null;
  }, [step.id, sectionIndex, sections, keyboardDrag]);
  useEffect(() => {
    if (
      editRequest?.kind !== "step" ||
      editRequest.id !== step.id ||
      handledEditRequestRef.current === editRequest.requestId
    ) {
      return;
    }
    handledEditRequestRef.current = editRequest.requestId;
    editHandleRef.current?.triggerEdit();
  }, [step.id, editRequest]);
  useEffect(() => {
    if (keyboardTarget && !movable) onKeyboardDragChange(null);
  }, [keyboardTarget, movable, onKeyboardDragChange]);
  const { dragRef, dragHandleRef, dragging } = useDraggable<JourneyDndData>(
    () => ({
      canDrag: Boolean(movable),
      data: {
        type: "journey-step",
        mapId,
        stepId: step.id,
        sectionId: step.sectionId,
      },
      dragPreviewPosition: "pointer-outside",
    }),
    [mapId, step.sectionId, step.id, movable],
  );
  const { closestEdge, draggedOver, dropTargetRef } =
    useDropTarget<JourneyDndData>(
      () => ({
        canDrop: ({ source }) =>
          !readonly &&
          Boolean(onMoveStep) &&
          step.move?.enabled !== false &&
          sections.find((section) => section.id === step.sectionId)?.add
            ?.enabled !== false &&
          source.data.mapId === mapId &&
          source.data.type === "journey-step" &&
          source.data.stepId !== step.id,
        closestEdge: { allowedEdges: ["left", "right"] },
        data: {
          type: "journey-step",
          mapId,
          stepId: step.id,
          sectionId: step.sectionId,
        },
        dropEffect: "move",
        onDrop: async ({ source, closestEdge: edge }) => {
          if (
            source.data.mapId !== mapId ||
            source.data.type !== "journey-step" ||
            (edge !== "left" && edge !== "right")
          ) {
            return;
          }
          const { stepId: sourceStepId, sectionId: sourceSectionId } =
            source.data;
          const move: JourneyMapStepMove = {
            stepId: sourceStepId,
            fromSectionId: sourceSectionId,
            toSectionId: step.sectionId,
            targetStepId: step.id,
            edge: edge === "left" ? "before" : "after",
          };
          if (!wouldMoveJourneyStep(sections, move)) return;
          if ((await onMoveStep?.(move)) === false) return;
          const sourceSection = sections.find(
            (section) => section.id === sourceSectionId,
          );
          const sourceStep = sourceSection?.steps.find(
            (candidate) => candidate.id === sourceStepId,
          );
          if (sourceSection && sourceStep) {
            announce(
              labels.movedStep(
                sourceStep.label,
                sourceSection.label,
                sections[sectionIndex]?.label ?? sourceSection.label,
              ),
            );
          }
        },
      }),
      [
        announce,
        mapId,
        step.sectionId,
        step.id,
        sectionIndex,
        sections,
        labels,
        onMoveStep,
        readonly,
      ],
    );
  const stepRef = useCallback(
    (node: HTMLDivElement | null) => {
      stepElementRef.current = node;
      dragRef.current = node;
      dropTargetRef.current = node;
    },
    [dragRef, dropTargetRef],
  );
  const handleKeyboardDrag = async (event: KeyboardEvent<HTMLDivElement>) => {
    if (!movable) return;
    if (event.key === "Escape" && (keyboardTarget !== null || dragging)) {
      event.preventDefault();
      onKeyboardDragChange(null);
      return;
    }
    if (
      keyboardTarget !== null &&
      (event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown")
    ) {
      event.preventDefault();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const nextSectionIndex = Math.max(
          0,
          Math.min(sections.length - 1, keyboardTarget.sectionIndex + delta),
        );
        const targetSteps =
          sections[nextSectionIndex]?.steps.filter(
            (candidate) => candidate.id !== step.id,
          ) ?? [];
        onKeyboardDragChange({
          stepId: step.id,
          sectionIndex: nextSectionIndex,
          insertionIndex: Math.min(
            keyboardTarget.insertionIndex,
            targetSteps.length,
          ),
        });
        return;
      }
      const targetSteps =
        sections[keyboardTarget.sectionIndex]?.steps.filter(
          (candidate) => candidate.id !== step.id,
        ) ?? [];
      onKeyboardDragChange({
        stepId: step.id,
        sectionIndex: keyboardTarget.sectionIndex,
        insertionIndex: Math.max(
          0,
          Math.min(
            targetSteps.length,
            keyboardTarget.insertionIndex + (event.key === "ArrowUp" ? -1 : 1),
          ),
        ),
      });
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (keyboardTarget === null) {
      onInteractionStart?.("step", step.id, "move");
      const sourceSteps =
        sections[sectionIndex]?.steps.filter(
          (candidate) => candidate.id !== step.id,
        ) ?? [];
      const sourceIndex =
        sections[sectionIndex]?.steps.findIndex(
          (candidate) => candidate.id === step.id,
        ) ?? -1;
      onKeyboardDragChange({
        stepId: step.id,
        sectionIndex,
        insertionIndex:
          sourceIndex < 0
            ? sourceSteps.length
            : Math.min(sourceIndex, sourceSteps.length),
      });
      return;
    }
    const target = sections[keyboardTarget.sectionIndex];
    const targetSteps =
      target?.steps.filter((candidate) => candidate.id !== step.id) ?? [];
    if (target) {
      const targetStepId = targetSteps[keyboardTarget.insertionIndex]?.id;
      const move: JourneyMapStepMove = {
        stepId: step.id,
        fromSectionId: step.sectionId,
        toSectionId: target.id,
        targetStepId,
        edge: targetStepId ? "before" : undefined,
      };
      if (!wouldMoveJourneyStep(sections, move)) {
        onKeyboardDragChange(null);
        return;
      }
      if ((await onMoveStep?.(move)) === false) {
        onKeyboardDragChange(null);
        return;
      }
      const source = sections[sectionIndex];
      if (source) {
        announce(labels.movedStep(step.label, source.label, target.label));
      }
    }
    onKeyboardDragChange(null);
  };
  const content = (
    <Card
      ref={stepRef}
      withBorder
      className="mantine-focus-auto myoxus-journey-step-card"
      aria-current={selected ? "true" : undefined}

      data-myoxus-ui-role="journey-step"
      data-step-id={step.id}
      data-selected={
        selected || dragging || draggedOver || keyboardTarget !== null
          ? "true"
          : undefined
      }
      data-testid={step.testId ?? "journey-step"}

      role="group"
      tabIndex={selectable || openable ? 0 : undefined}
      aria-label={step.label}
      onPointerDown={(event) => {
        if (!isJourneyActionTarget(event.target, event.currentTarget)) {
          onSelectStep?.(step.id, event.currentTarget);
        }
      }}
      // Reuse the Facade selection border; Task actions preclude a nested-button selection root.
      style={{
        borderColor:
          selected || step.highlighted ? cssVar("primaryColor") : undefined,
      }}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget || !openable) return;
        event.preventDefault();
        onOpenStep?.(step.id, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "F2" && !readonly && step.rename?.enabled !== false) {
          event.preventDefault();
          editHandleRef.current?.triggerEdit();
          return;
        }
        if (event.key === " " && selectable) {
          event.preventDefault();
          onSelectStep?.(step.id, event.currentTarget);
          return;
        }
        if (event.key !== "Enter" || !openable) return;
        event.preventDefault();
        onOpenStep?.(step.id, event.currentTarget);
      }}
    >
      <DropIndicator edge={closestEdge ?? keyboardDropEdge} />
      {step.precedingContent}
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        {
          <Tooltip label={step.label} openDelay={500}>
            <Box
              miw={0}
              w="100%"
              onClickCapture={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest(
                    '[data-myoxus-ui-role="inline-edit-display"]',
                  )
                )
                  onSelectStep?.(step.id, event.currentTarget);
              }}
              onKeyDownCapture={(event) => {
                if (
                  !(event.target instanceof Element) ||
                  !event.target.closest(
                    '[data-myoxus-ui-role="inline-edit-display"]',
                  )
                )
                  return;
                if (event.key === " ") {
                  event.preventDefault();
                  onSelectStep?.(step.id, event.currentTarget);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  onOpenStep?.(step.id, event.currentTarget);
                }
              }}
            >
              <InlineEdit
                handleRef={editHandleRef}
                editable={
                  !readonly &&
                  step.rename?.enabled !== false &&
                  Boolean(onRenameStep)
                }
                trigger="doubleClick"
                value={step.label}
                onInput={(label) => onEditInput?.("step", step.id, label)}
                renderDisplay={renderLabel}
                displayLineClamp={2}
                onChange={(label) => void onRenameStep?.(step.id, label)}
                onEditStart={() => {
                  onInteractionStart?.("step", step.id, "rename");
                  setInteractionDisabled(true);
                }}
                onEditEnd={(outcome) => {
                  setInteractionDisabled(false);
                  onEditEnd?.("step", step.id, outcome);
                }}
                inputAttrs={{
                  "aria-label":
                    step.label || labels.addStep(sections[sectionIndex]!.label),
                }}
              />
            </Box>
          </Tooltip>
        }
        {!readonly ? (
          <DragHandle
            ref={dragHandleRef}
            aria-label={labels.dragStep(step.label)}
            disabled={!movable}
            dragging={dragging || keyboardTarget !== null}
            onKeyDown={handleKeyboardDrag}
            onPointerDown={() => {
              onInteractionStart?.("step", step.id, "move");
              onKeyboardDragChange(null);
            }}
            aria-pressed={keyboardTarget !== null}
            data-myoxus-journey-interaction="drag"
          />
        ) : null}
      </Group>
      <Group>
        {step.actors.filter(Boolean).map((actor, index) => (
          <Badge key={index} variant={step.highlighted ? "filled" : "light"}>
            {actor}
          </Badge>
        ))}
      </Group>
      {step.content}
      {step.diagnostic ? <Alert>{step.diagnostic}</Alert> : null}
      {step.actions || openable || removable ? (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          {step.actions ? (
            <Box data-myoxus-journey-interaction="custom-actions">
              {step.actions}
            </Box>
          ) : null}
          {openable || removable ? (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  aria-label={`${labels.actions}: ${step.label}`}
                  data-myoxus-journey-interaction="actions"
                >
                  <MoreHorizontalIcon />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {openable ? (
                  <Menu.Item
                    onClick={(event) =>
                      onOpenStep?.(
                        step.id,
                        stepElementRef.current ?? event.currentTarget,
                      )
                    }
                  >
                    {labels.openStep(step.label)}
                  </Menu.Item>
                ) : null}
                {removable ? (
                  <Menu.Item
                    color="myoxusError"
                    leftSection={<TrashIcon />}
                    onClick={() => void onDeleteStep?.(step.id)}
                  >
                    {labels.deleteStep(step.label)}
                  </Menu.Item>
                ) : null}
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
      ) : null}
    </Card>
  );
  const framed = step.frame ? step.frame(content, { dragging }) : content;
  return (
    <Box
      component="li"
      data-myoxus-ui-role="journey-step-item"
      role="listitem"
      className="myoxus-journey-step-track"
    >
      <Box className="myoxus-journey-marker-track">
        {Number.isFinite(step.score) ? (
          // Keep centering off the native Button: Mantine's :active transform
          // otherwise moves its hit area between pointer-down and pointer-up.
          <Box
            className="myoxus-journey-score-marker-position"
            style={{
              top:
                24 +
                (5 -
                  Math.max(
                    1,
                    Math.min(5, Number.isFinite(step.score) ? step.score : 1),
                  )) *
                  48,
            }}
          >
            <Button
              variant={selected ? "filled" : "default"}
              className="myoxus-journey-score-control"
              data-myoxus-ui-role="journey-score-marker"
              aria-label={labels.score(step.score)}
              onPointerDown={(event) => {
                if (step.draft) {
                  event.preventDefault();
                  onOpenStep?.(
                    step.id,
                    stepElementRef.current ?? event.currentTarget,
                  );
                  editHandleRef.current?.discardDraft();
                }
              }}
              onClick={(event) =>
                onOpenStep?.(
                  step.id,
                  stepElementRef.current ?? event.currentTarget,
                )
              }
            >
              {labels.scoreValue(step.score)}
            </Button>
          </Box>
        ) : null}
      </Box>
      {framed}
    </Box>
  );
}
