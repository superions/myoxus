// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";

import { MoreHorizontalIcon, PlusIcon, TrashIcon } from "@myoxus/icons/react";

import { useCallback, useEffect, useRef } from "react";

import { DragHandle } from "../../drag-handle";
import { DropIndicator } from "../../dnd/drop-indicator";
import { useDraggable } from "../../dnd/draggable";
import { useDropTarget } from "../../dnd/drop-target";

import { InlineEdit, type InlineEditHandle } from "../../inline-edit";

import type {
  JourneyMapSelection,
  JourneyMapSection,
  JourneyMapStepMove,
  JourneyMapSectionMove,
  JourneyMapLabels,
  JourneyMapProps,
} from "./types";
import {
  wouldMoveJourneyStep,
  wouldMoveJourneySection,
  isJourneyActionTarget,
  type JourneyDndData,
  type JourneyKeyboardStepDrag,
  type JourneyKeyboardSectionDrag,
} from "./journey-dnd";
import { JourneyStep } from "./journey-step";
export function JourneySection({
  section,
  gridStart,
  mapId,
  sectionIndex,
  sections,
  labels,
  renderLabel,
  readonly,
  selection,
  onAddStep,
  onInteractionStart,
  onEditInput,
  onEditEnd,
  onOpenSection,
  onMoveStep,
  onOpenStep,
  onSelectStep,
  onSelectSection,
  onRenameStep,
  onRenameSection,
  onDeleteStep,
  onDeleteSection,
  onMoveSection,
  editRequest,
  keyboardStepDrag,
  keyboardSectionDrag,
  onKeyboardStepDragChange,
  onKeyboardSectionDragChange,
  announce,
}: {
  section: JourneyMapSection;
  gridStart: number;
  mapId: string;
  sectionIndex: number;
  sections: ReadonlyArray<JourneyMapSection>;
  labels: JourneyMapLabels;
  renderLabel?: JourneyMapProps["renderLabel"];
  readonly: boolean;
  selection?: JourneyMapSelection;
  onAddStep?: JourneyMapProps["onAddStep"];
  onEditInput?: JourneyMapProps["onEditInput"];
  onInteractionStart?: JourneyMapProps["onInteractionStart"];
  onEditEnd?: JourneyMapProps["onEditEnd"];
  onOpenSection?: JourneyMapProps["onOpenSection"];
  onMoveStep?: JourneyMapProps["onMoveStep"];
  onOpenStep?: JourneyMapProps["onOpenStep"];
  onSelectStep?: JourneyMapProps["onSelectStep"];
  onSelectSection?: JourneyMapProps["onSelectSection"];
  onRenameStep?: JourneyMapProps["onRenameStep"];
  onRenameSection?: JourneyMapProps["onRenameSection"];
  onDeleteStep?: JourneyMapProps["onDeleteStep"];
  onDeleteSection?: JourneyMapProps["onDeleteSection"];
  onMoveSection?: JourneyMapProps["onMoveSection"];
  editRequest?: JourneyMapProps["editRequest"];
  keyboardStepDrag: JourneyKeyboardStepDrag | null;
  keyboardSectionDrag: JourneyKeyboardSectionDrag | null;
  onKeyboardStepDragChange: (drag: JourneyKeyboardStepDrag | null) => void;
  onKeyboardSectionDragChange: (
    drag: JourneyKeyboardSectionDrag | null,
  ) => void;
  announce: (message: string) => void;
}) {
  const editHandleRef = useRef<InlineEditHandle>(null);
  const handledEditRequestRef = useRef<number | undefined>(undefined);
  const sectionElementRef = useRef<HTMLDivElement | null>(null);
  const keyboardSectionIndex =
    keyboardSectionDrag?.sectionId === section.id
      ? keyboardSectionDrag.targetIndex
      : null;
  const keyboardSectionDropEdge =
    keyboardSectionDrag &&
    keyboardSectionDrag.sectionId !== section.id &&
    keyboardSectionDrag.targetIndex === sectionIndex
      ? sectionIndex <
        sections.findIndex(
          (candidate) => candidate.id === keyboardSectionDrag.sectionId,
        )
        ? "left"
        : "right"
      : null;
  const keyboardStepDropIntoEmpty = Boolean(
    keyboardStepDrag &&
    keyboardStepDrag.sectionIndex === sectionIndex &&
    sections.some(
      (candidate, candidateIndex) =>
        candidateIndex !== sectionIndex &&
        candidate.steps.some((step) => step.id === keyboardStepDrag.stepId),
    ) &&
    section.steps.every((step) => step.id === keyboardStepDrag.stepId),
  );
  const movableSection =
    !readonly && section.reorder?.enabled !== false && onMoveSection;
  const {
    dragRef: sectionDragRef,
    dragHandleRef: sectionDragHandleRef,
    dragging: sectionDragging,
  } = useDraggable<JourneyDndData>(
    () => ({
      canDrag: Boolean(movableSection),
      data: { type: "journey-section", mapId, sectionId: section.id },
      dragPreviewPosition: "pointer-outside",
    }),
    [mapId, section.id, movableSection],
  );
  const showAdd = !readonly && section.add !== undefined && Boolean(onAddStep);
  const canAdd = !readonly && section.add?.enabled !== false;
  useEffect(() => {
    if (
      editRequest?.kind !== "section" ||
      editRequest.id !== section.id ||
      handledEditRequestRef.current === editRequest.requestId
    ) {
      return;
    }
    handledEditRequestRef.current = editRequest.requestId;
    editHandleRef.current?.triggerEdit();
  }, [section.id, editRequest]);
  const {
    closestEdge: sectionClosestEdge,
    draggedOver,
    dropTargetRef,
  } = useDropTarget<JourneyDndData>(
    () => ({
      canDrop: ({ source, closestEdge }) =>
        !readonly &&
        source.data.mapId === mapId &&
        ((Boolean(onMoveStep) &&
          section.add?.enabled !== false &&
          source.data.type === "journey-step") ||
          (Boolean(onMoveSection) &&
            source.data.type === "journey-section" &&
            (section.reorder?.enabled !== false ||
              (Boolean(section.implicit) && closestEdge === "right")) &&
            source.data.sectionId !== section.id)),
      closestEdge: { allowedEdges: ["left", "right"] },
      data: { type: "journey-section", mapId, sectionId: section.id },
      dropEffect: "move",
      onDrop: async ({ source, location, closestEdge }) => {
        if (source.data.mapId !== mapId) return;
        if (source.data.type === "journey-section") {
          if (closestEdge !== "left" && closestEdge !== "right") return;
          const movingSectionId = source.data.sectionId;
          const move: JourneyMapSectionMove = {
            sectionId: movingSectionId,
            targetSectionId: section.id,
            edge: closestEdge === "left" ? "before" : "after",
          };
          if (!wouldMoveJourneySection(sections, move)) return;
          if ((await onMoveSection?.(move)) === false) return;
          const movingSection = sections.find(
            (candidate) => candidate.id === movingSectionId,
          );
          if (movingSection) {
            announce(labels.movedSection(movingSection.label, section.label));
          }
          return;
        }
        if (source.data.type !== "journey-step") return;
        const { stepId: sourceStepId, sectionId: sourceSectionId } =
          source.data;
        const hasStepTarget = location.current.dropTargets.some(
          (target) =>
            (target.data as JourneyDndData["dropTarget"] | undefined)?.type ===
            "journey-step",
        );
        if (hasStepTarget) return;
        const sourceSection = sections.find(
          (candidate) => candidate.id === sourceSectionId,
        );
        const sourceStep = sourceSection?.steps.find(
          (candidate) => candidate.id === sourceStepId,
        );
        const move: JourneyMapStepMove = {
          stepId: sourceStepId,
          fromSectionId: sourceSectionId,
          toSectionId: section.id,
        };
        if (!wouldMoveJourneyStep(sections, move)) return;
        if ((await onMoveStep?.(move)) === false) return;
        if (sourceSection && sourceStep) {
          announce(
            labels.movedStep(
              sourceStep.label,
              sourceSection.label,
              section.label,
            ),
          );
        }
      },
    }),
    [
      announce,
      mapId,
      section.id,
      sections,
      labels,
      onMoveStep,
      onMoveSection,
      readonly,
    ],
  );
  const sectionRef = useCallback(
    (node: HTMLDivElement | null) => {
      sectionElementRef.current = node;
      dropTargetRef.current = node;
      sectionDragRef.current = node;
    },
    [sectionDragRef, dropTargetRef],
  );
  const content = (
    <Box
      component="li"
      className="myoxus-journey-section-track"
      style={{
        gridColumn: `${gridStart}/span ${Math.max(1, section.steps.length)}`,
      }}
      data-myoxus-ui-role="journey-section-frame"
      data-testid={section.frameTestId ?? "journey-section-frame"}
      role="listitem"
    >
      <Box
        ref={sectionRef}
        className="mantine-focus-auto myoxus-journey-section-grid"
        aria-current={selection?.sectionId === section.id ? "true" : undefined}
        data-myoxus-ui-role="journey-section"
        data-section-id={section.id}
        data-selected={
          selection?.sectionId === section.id ||
          draggedOver ||
          sectionDragging ||
          keyboardSectionIndex !== null
            ? "true"
            : undefined
        }
        data-testid={section.testId ?? "journey-section"}
        role="group"
        tabIndex={onSelectSection ? 0 : undefined}
        aria-label={section.label || labels.unnamedSection}
        onPointerDown={(event) => {
          if (
            (!(event.target instanceof Element) ||
              !event.target.closest("[data-step-id]")) &&
            !isJourneyActionTarget(event.target, event.currentTarget)
          ) {
            onSelectSection?.(section.id, event.currentTarget);
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            event.key === "F2" &&
            !readonly &&
            section.rename?.enabled !== false
          ) {
            event.preventDefault();
            editHandleRef.current?.triggerEdit();
            return;
          }
          if (event.key === "Enter" && onOpenSection) {
            event.preventDefault();
            onOpenSection(section.id, event.currentTarget);
            return;
          }
          if (event.key === " ") {
            event.preventDefault();
            onSelectSection?.(section.id, event.currentTarget);
          }
        }}
      >
        <DropIndicator edge={sectionClosestEdge ?? keyboardSectionDropEdge} />
        <Card withBorder className="myoxus-journey-section-header">
          <Stack>
            {section.precedingContent}
            <Group justify="space-between" wrap="nowrap">
              <Box flex="1 1 auto" miw={0}>
                <Tooltip label={section.label} openDelay={500}>
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
                        onSelectSection?.(section.id, event.currentTarget);
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
                        onSelectSection?.(section.id, event.currentTarget);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        onOpenSection?.(section.id, event.currentTarget);
                      }
                    }}
                  >
                    <InlineEdit
                      handleRef={editHandleRef}
                      editable={
                        !readonly &&
                        section.rename?.enabled !== false &&
                        Boolean(onRenameSection)
                      }
                      trigger="doubleClick"
                      value={section.label}
                      placeholder={
                        section.implicit ? labels.unnamedSection : undefined
                      }
                      onInput={(label) =>
                        onEditInput?.("section", section.id, label)
                      }
                      renderDisplay={renderLabel}
                      onEditStart={() =>
                        onInteractionStart?.("section", section.id, "rename")
                      }
                      onEditEnd={(outcome) =>
                        onEditEnd?.("section", section.id, outcome)
                      }
                      displayLineClamp={1}
                      onChange={(label) =>
                        void onRenameSection?.(section.id, label)
                      }
                      inputAttrs={{
                        "aria-label":
                          section.label ||
                          (section.implicit
                            ? labels.unnamedSection
                            : labels.addSection),
                      }}
                    />
                  </Box>
                </Tooltip>
              </Box>
              <Badge
                variant="light"
                aria-label={labels.stepCount(section.steps.length)}
              >
                {section.steps.length}
              </Badge>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              {section.actions ? (
                <Box data-myoxus-journey-interaction="custom-actions">
                  {section.actions}
                </Box>
              ) : null}
              {movableSection ? (
                <DragHandle
                  ref={sectionDragHandleRef}
                  aria-label={labels.dragSection(section.label)}
                  dragging={sectionDragging || keyboardSectionIndex !== null}
                  onKeyboardMove={(delta) => {
                    if (keyboardSectionIndex === null) return;
                    const nextIndex = Math.max(
                      0,
                      Math.min(
                        sections.length - 1,
                        keyboardSectionIndex + delta,
                      ),
                    );
                    const target = sections[nextIndex];
                    if (!target || nextIndex === keyboardSectionIndex) return;
                    onKeyboardSectionDragChange({
                      sectionId: section.id,
                      targetIndex: nextIndex,
                    });
                  }}
                  onKeyDown={async (event) => {
                    if (
                      event.key === "Escape" &&
                      (keyboardSectionIndex !== null || sectionDragging)
                    ) {
                      event.preventDefault();
                      onKeyboardSectionDragChange(null);
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (keyboardSectionIndex === null) {
                      onInteractionStart?.("section", section.id, "move");
                      onKeyboardSectionDragChange({
                        sectionId: section.id,
                        targetIndex: sectionIndex,
                      });
                      return;
                    }
                    const target = sections[keyboardSectionIndex];
                    if (target && target.id !== section.id) {
                      const accepted = await onMoveSection?.({
                        sectionId: section.id,
                        targetSectionId: target.id,
                        edge:
                          keyboardSectionIndex < sectionIndex
                            ? "before"
                            : "after",
                      });
                      if (accepted !== false)
                        announce(
                          labels.movedSection(section.label, target.label),
                        );
                    }
                    onKeyboardSectionDragChange(null);
                  }}
                  onPointerDown={() => {
                    onInteractionStart?.("section", section.id, "move");
                    onKeyboardSectionDragChange(null);
                  }}
                  aria-pressed={keyboardSectionIndex !== null}
                  data-myoxus-journey-interaction="drag"
                />
              ) : null}
              {onOpenSection ||
              (!readonly &&
                section.remove?.enabled !== false &&
                onDeleteSection) ? (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      aria-label={`${labels.actions}: ${section.label}`}
                      data-myoxus-journey-interaction="actions"
                    >
                      <MoreHorizontalIcon />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {onOpenSection ? (
                      <Menu.Item
                        onClick={(event) =>
                          onOpenSection(
                            section.id,
                            sectionElementRef.current ?? event.currentTarget,
                          )
                        }
                      >
                        {labels.openStep(section.label)}
                      </Menu.Item>
                    ) : null}
                    {!readonly &&
                    onDeleteSection &&
                    section.remove?.enabled !== false ? (
                      <Menu.Item
                        color="myoxusError"
                        leftSection={<TrashIcon />}
                        onClick={(event) =>
                          void onDeleteSection(
                            section.id,
                            sectionElementRef.current ?? event.currentTarget,
                          )
                        }
                      >
                        {labels.deleteSection(section.label)}
                      </Menu.Item>
                    ) : null}
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </Group>
          </Stack>
        </Card>
        {section.steps.length === 0 ? (
          <Box pos="relative" className="myoxus-journey-empty-track">
            <DropIndicator edge={keyboardStepDropIntoEmpty ? "bottom" : null} />
            <Text
              c="dimmed"
              size="sm"
              data-myoxus-ui-role="journey-empty-section"
            >
              {labels.emptySection}
            </Text>
          </Box>
        ) : null}
        <Box
          component="ul"
          className="myoxus-journey-step-list"
          data-myoxus-ui-role="journey-step-list"
          role="list"
        >
          {section.steps.map((step) => (
            <JourneyStep
              key={step.id}
              step={step}
              mapId={mapId}
              sectionIndex={sectionIndex}
              sections={sections}
              labels={labels}
              renderLabel={renderLabel}
              readonly={readonly}
              selected={selection?.stepId === step.id}
              editRequest={editRequest}
              onInteractionStart={onInteractionStart}
              onEditInput={onEditInput}
              onEditEnd={onEditEnd}
              onMoveStep={onMoveStep}
              onOpenStep={onOpenStep}
              onSelectStep={onSelectStep}
              onRenameStep={onRenameStep}
              onDeleteStep={onDeleteStep}
              keyboardDrag={keyboardStepDrag}
              onKeyboardDragChange={onKeyboardStepDragChange}
              announce={announce}
            />
          ))}
        </Box>
        {showAdd ? (
          <Button
            className="myoxus-journey-add-step"
            variant="subtle"
            leftSection={<PlusIcon />}
            aria-label={labels.addStep(section.label)}
            data-testid={
              section.addStepTestId ??
              (section.steps.length === 0
                ? "journey-empty-cta"
                : "journey-section-new")
            }
            disabled={!canAdd}
            data-myoxus-journey-interaction="add"
            onClick={() => void onAddStep?.(section.id)}
          >
            {labels.addStep(section.label)}
          </Button>
        ) : null}
      </Box>
    </Box>
  );
  return section.frame ? section.frame(content) : content;
}
