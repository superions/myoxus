// SPDX-License-Identifier: AGPL-3.0-or-later

import "./journey.css";

import { Box, Button, Stack, Text, VisuallyHidden } from "@mantine/core";
import { PrimaryScrollArea } from "../primary-scroll-area";
import { PlusIcon } from "@myoxus/icons/react";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { monitorForElements } from "../../dnd/monitor";

import { JourneyScorePath } from "./journey-score-path";
import { useJourneyScroll } from "./journey-scroll";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type {
  JourneyMapStepMove,
  JourneyMapSectionMove,
  JourneyMapProps,
} from "./types";
import {
  previewJourneyMove,
  type JourneyDndData,
  type JourneyKeyboardStepDrag,
  type JourneyKeyboardSectionDrag,
} from "./journey-dnd";
import { JourneySection } from "./journey-section";
export function JourneyMap({
  sections,
  stepWidth = 180,
  labels,
  renderLabel,
  selection,
  readonly = false,
  scrollOwner = "self",
  toolbar,
  empty,
  error,
  addSection,
  editRequest,
  focusRequest,
  onAddStep,
  onAddSection,
  onInteractionStart,
  onEditInput,
  onEditEnd,
  onOpenSection,
  onMoveStep,
  onMoveSection,
  onOpenStep,
  onSelectionTargetChange,
  onSelectStep,
  onSelectSection,
  onDeleteStep,
  onDeleteSection,
  onRenameStep,
  onRenameSection,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
}: JourneyMapProps) {
  const instanceId = useId();
  const [interactionGeneration, setInteractionGeneration] = useState(0);
  const mapId = `${instanceId}-${interactionGeneration}`;
  const [announcement, setAnnouncement] = useState({
    message: "",
    sequence: 0,
  });
  const [keyboardStepDrag, setKeyboardStepDrag] =
    useState<JourneyKeyboardStepDrag | null>(null);
  const [keyboardSectionDrag, setKeyboardSectionDrag] =
    useState<JourneyKeyboardSectionDrag | null>(null);
  const [pointerMove, setPointerMove] = useState<
    JourneyMapStepMove | JourneyMapSectionMove
  >();
  const mapRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const autoScrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const selectionTargetChangeRef = useRef(onSelectionTargetChange);
  selectionTargetChangeRef.current = onSelectionTargetChange;
  useEffect(() => {
    if (!readonly && (!focusRequest || focusRequest.revealOnly)) return;
    // Returning focus after replay/apply cancels the previous gesture without
    // remounting the map or losing its scrollport. Old native drags retain the
    // previous map ID and therefore cannot apply through the new drop targets.
    setKeyboardStepDrag(null);
    setKeyboardSectionDrag(null);
    setPointerMove(undefined);
    setInteractionGeneration((generation) => generation + 1);
    autoScrollDirectionRef.current = 0;
    if (autoScrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = undefined;
    }
  }, [readonly, focusRequest]);
  const orderedSections = useMemo(() => [...sections], [sections]);
  const canAddSection =
    !readonly && addSection?.enabled !== false && onAddSection;
  const changeKeyboardStepDrag = useCallback(
    (drag: JourneyKeyboardStepDrag | null) => {
      setKeyboardStepDrag(drag);
      if (drag) setKeyboardSectionDrag(null);
    },
    [],
  );
  const changeKeyboardSectionDrag = useCallback(
    (drag: JourneyKeyboardSectionDrag | null) => {
      setKeyboardSectionDrag(drag);
      if (drag) setKeyboardStepDrag(null);
    },
    [],
  );
  const announce = useCallback((message: string) => {
    setAnnouncement((current) => ({
      message,
      sequence: current.sequence + 1,
    }));
  }, []);

  const move = useMemo<
    JourneyMapStepMove | JourneyMapSectionMove | undefined
  >(() => {
    if (readonly) return;
    if (keyboardStepDrag) {
      const drag = keyboardStepDrag;
      const from = sections.find((s) =>
        s.steps.some((step) => step.id === drag.stepId),
      );
      const to = sections[drag.sectionIndex];
      if (!from || !to) return;
      const target = to.steps.filter((s) => s.id !== drag.stepId)[
        drag.insertionIndex
      ];
      return {
        stepId: drag.stepId,
        fromSectionId: from.id,
        toSectionId: to.id,
        targetStepId: target?.id,
        edge: target ? "before" : undefined,
      };
    }
    if (keyboardSectionDrag) {
      const drag = keyboardSectionDrag,
        target = sections[drag.targetIndex];
      if (target)
        return {
          sectionId: drag.sectionId,
          targetSectionId: target.id,
          edge:
            drag.targetIndex <
            sections.findIndex((s) => s.id === drag.sectionId)
              ? "before"
              : "after",
        };
    }
    return pointerMove;
  }, [sections, readonly, keyboardStepDrag, keyboardSectionDrag, pointerMove]);
  const movePreview = useMemo(
    () => previewJourneyMove(sections, move),
    [sections, move],
  );
  useEffect(() => {
    if (!movePreview || !move) return;
    const isStep = "stepId" in move;
    const object = isStep
      ? sections.flatMap((s) => s.steps).find((s) => s.id === move.stepId)
          ?.label
      : sections.find((s) => s.id === move.sectionId)?.label;
    const target = isStep
      ? movePreview.find((s) => s.id === move.toSectionId)
      : sections.find((s) => s.id === move.targetSectionId);
    const position = isStep
      ? (target?.steps.findIndex((s) => s.id === move.stepId) ?? 0) + 1
      : movePreview.findIndex((s) => s.id === move.sectionId) + 1;
    announce(
      labels.moveTarget(
        isStep
          ? (object ?? "")
          : `${object ?? ""} (${labels.stepCount(sections.find((s) => s.id === move.sectionId)?.steps.length ?? 0)})`,
        target?.label || labels.unnamedSection,
        position,
      ),
    );
  }, [movePreview, move, labels, announce]);

  useEffect(() => {
    const keyboardStepSource = keyboardStepDrag
      ? sections
          .flatMap((section) => section.steps)
          .find((step) => step.id === keyboardStepDrag.stepId)
      : undefined;
    if (
      readonly ||
      (keyboardStepDrag &&
        (!onMoveStep ||
          keyboardStepDrag.sectionIndex < 0 ||
          keyboardStepDrag.sectionIndex >= sections.length ||
          !keyboardStepSource ||
          keyboardStepSource.move?.enabled === false))
    ) {
      setKeyboardStepDrag(null);
    }
    const keyboardSectionSource = keyboardSectionDrag
      ? sections.find((section) => section.id === keyboardSectionDrag.sectionId)
      : undefined;
    if (
      readonly ||
      (keyboardSectionDrag &&
        (!onMoveSection ||
          keyboardSectionDrag.targetIndex < 0 ||
          keyboardSectionDrag.targetIndex >= sections.length ||
          !keyboardSectionSource ||
          keyboardSectionSource.reorder?.enabled === false))
    ) {
      setKeyboardSectionDrag(null);
    }
  }, [
    sections,
    keyboardStepDrag,
    keyboardSectionDrag,
    onMoveStep,
    onMoveSection,
    readonly,
  ]);

  useEffect(() => {
    const targetIndex =
      keyboardStepDrag?.sectionIndex ?? keyboardSectionDrag?.targetIndex;
    const targetSection =
      targetIndex === undefined ? undefined : sections[targetIndex];
    if (!targetSection) return;
    const frame = window.requestAnimationFrame(() => {
      mapRef.current
        ?.querySelector<HTMLElement>(
          `[data-section-id="${CSS.escape(targetSection.id)}"]`,
        )
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sections, keyboardStepDrag, keyboardSectionDrag]);

  useEffect(() => {
    const stopAutoScroll = () => {
      autoScrollDirectionRef.current = 0;
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
    };
    const scrollFrame = () => {
      const viewport = scrollViewportRef.current;
      const direction = autoScrollDirectionRef.current;
      if (!viewport || direction === 0) {
        autoScrollFrameRef.current = undefined;
        return;
      }
      // Pointer-edge scrolling is renderer geometry; scale it from the owned
      // scrollport instead of coupling Map to a route or viewport breakpoint.
      viewport.scrollBy({
        left: direction * Math.max(4, viewport.clientWidth * 0.015),
      });
      autoScrollFrameRef.current = window.requestAnimationFrame(scrollFrame);
    };
    const cleanupMonitor = monitorForElements({
      canMonitor: ({ source }) => {
        const data = source.data as JourneyDndData["draggable"] | undefined;
        const sourceMap = source.element.closest(
          '[data-myoxus-ui-role="journey-map"]',
        );
        return (
          !readonly &&
          data?.mapId === mapId &&
          sourceMap === mapRef.current &&
          (data?.type === "journey-step" || data?.type === "journey-section")
        );
      },
      onDrag: ({ location, source }) => {
        const data = source.data as JourneyDndData["draggable"];
        const target = location.current.dropTargets[0]?.data as
          JourneyDndData["dropTarget"] | undefined;
        const edge = target ? extractClosestEdge(target) : null;
        let next: JourneyMapStepMove | JourneyMapSectionMove | undefined;
        if (target?.mapId === mapId && data.type === "journey-step") {
          next = {
            stepId: data.stepId,
            fromSectionId: data.sectionId,
            toSectionId: target.sectionId,
            ...(target.type === "journey-step"
              ? {
                  targetStepId: target.stepId,
                  edge:
                    edge === "left" ? ("before" as const) : ("after" as const),
                }
              : {}),
          };
        } else if (
          target?.type === "journey-section" &&
          target.mapId === mapId &&
          data.type === "journey-section"
        ) {
          next = {
            sectionId: data.sectionId,
            targetSectionId: target.sectionId,
            edge: edge === "left" ? "before" : "after",
          };
        }
        setPointerMove((current) =>
          JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
        const viewport = scrollViewportRef.current;
        if (!viewport) return;
        const { bottom, left, right, top, width } =
          viewport.getBoundingClientRect();
        const pointerX = location.current.input.clientX;
        const pointerY = location.current.input.clientY;
        const edgeZone = width * 0.1;
        autoScrollDirectionRef.current =
          pointerY < top ||
          pointerY > bottom ||
          pointerX < left ||
          pointerX > right
            ? 0
            : pointerX < left + edgeZone
              ? -1
              : pointerX > right - edgeZone
                ? 1
                : 0;
        if (
          autoScrollDirectionRef.current !== 0 &&
          autoScrollFrameRef.current === undefined
        ) {
          autoScrollFrameRef.current =
            window.requestAnimationFrame(scrollFrame);
        }
      },
      onDrop: () => {
        stopAutoScroll();
        setPointerMove(undefined);
      },
    });
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        stopAutoScroll();
        setPointerMove(undefined);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      stopAutoScroll();
      cleanupMonitor();
      window.removeEventListener("keydown", handleEscape);
    };
  }, [readonly, mapId]);

  useEffect(() => {
    if (!focusRequest) return;
    let frame: number | undefined;
    let attempts = 0;
    const focus = () => {
      const { selection } = focusRequest;
      const id = selection?.stepId ?? selection?.sectionId;
      const attribute = selection?.stepId ? "data-step-id" : "data-section-id";
      const target =
        focusRequest.target === "map"
          ? mapRef.current
          : focusRequest.target === "add-section-empty"
            ? mapRef.current?.querySelector<HTMLElement>(
                '[data-myoxus-journey-focus="add-section-empty"]',
              )
            : id
              ? mapRef.current?.querySelector<HTMLElement>(
                  `[${attribute}="${CSS.escape(id)}"]`,
                )
              : null;
      if (target) {
        selectionTargetChangeRef.current?.(target);
        if (focusRequest.revealOnly)
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
        else target.focus();
        return;
      }
      attempts += 1;
      if (attempts < 12) frame = window.requestAnimationFrame(focus);
    };
    frame = window.requestAnimationFrame(focus);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [focusRequest]);

  useEffect(() => {
    const id = selection?.stepId ?? selection?.sectionId;
    if (!id || !onSelectionTargetChange) return;
    const attribute = selection?.stepId ? "data-step-id" : "data-section-id";
    const frame = window.requestAnimationFrame(() => {
      const target = mapRef.current?.querySelector<HTMLElement>(
        `[${attribute}="${CSS.escape(id)}"]`,
      );
      if (target) onSelectionTargetChange(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sections, onSelectionTargetChange, selection]);

  useJourneyScroll(mapRef, scrollViewportRef);
  return (
    <Stack
      ref={mapRef}
      aria-label={ariaLabel}
      data-myoxus-ui-role="journey-map"
      data-testid={dataTestId}
      role="region"
      tabIndex={-1}
      gap="xs"
    >
      {toolbar}
      {error ? (
        <Box data-myoxus-ui-role="journey-error" role="alert">
          {error}
        </Box>
      ) : null}
      {sections.length === 0 ? (
        <Stack align="flex-start" data-myoxus-ui-role="journey-empty">
          {empty}
          {canAddSection ? (
            <Button
              variant="subtle"
              leftSection={<PlusIcon />}
              aria-label={labels.addSection}
              data-myoxus-journey-focus="add-section-empty"
              onClick={(event) => void onAddSection?.(event.currentTarget)}
            >
              {labels.addSection}
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {sections.length > 0 ? (
        <PrimaryScrollArea
          data-myoxus-ui-role="journey-map-scroll-root"
          offsetScrollbars="x"
          scrollbars="xy"
          owner={scrollOwner}
          autosize={scrollOwner === "self"}
          // As in the time workarea, native Autosize bounds the owned
          // renderer plane; tall sections share this one vertical/horizontal owner.
          mah={scrollOwner === "self" ? "70vh" : undefined}
          type="auto"
          viewportRef={scrollViewportRef}
        >
          <Box
            className="myoxus-journey-plane"
            style={{
              gridTemplateColumns: `max-content repeat(${Math.max(
                1,
                sections.reduce((n, s) => n + Math.max(1, s.steps.length), 0),
              )}, ${stepWidth}px)`,
            }}
          >
            <JourneyScorePath
              sections={sections}
              preview={movePreview}
              previewLabel={
                "stepId" in (move ?? {})
                  ? labels.dragStep(
                      sections
                        .flatMap((s) => s.steps)
                        .find(
                          (s) => s.id === (move as JourneyMapStepMove).stepId,
                        )?.label ?? "",
                    )
                  : move && "sectionId" in move
                    ? `${labels.dragSection(sections.find((s) => s.id === move.sectionId)?.label ?? "")} (${labels.stepCount(sections.find((s) => s.id === move.sectionId)?.steps.length ?? 0)})`
                    : labels.actions
              }
              stepWidth={stepWidth}
              labels={labels}
            />
            <Text className="myoxus-journey-axis-title">
              {labels.scoreAxis}
            </Text>
            <Box className="myoxus-journey-axis" aria-label={labels.scoreAxis}>
              {[5, 4, 3, 2, 1].map((score, index) => (
                <Box
                  key={score}
                  className="myoxus-journey-axis-value"
                  style={{ top: 24 + index * 48 }}
                >
                  {labels.scoreValue(score)}
                </Box>
              ))}
            </Box>
            {orderedSections.map((section, index) => (
              <JourneySection
                key={section.id}
                section={section}
                gridStart={
                  2 +
                  orderedSections
                    .slice(0, index)
                    .reduce((n, s) => n + Math.max(1, s.steps.length), 0)
                }
                mapId={mapId}
                sectionIndex={index}
                sections={orderedSections}
                labels={labels}
                renderLabel={renderLabel}
                readonly={readonly}
                selection={selection}
                editRequest={editRequest}
                onAddStep={onAddStep}
                onInteractionStart={onInteractionStart}
                onEditInput={onEditInput}
                onEditEnd={onEditEnd}
                onOpenSection={onOpenSection}
                onMoveStep={onMoveStep}
                onMoveSection={onMoveSection}
                onOpenStep={onOpenStep}
                onSelectStep={onSelectStep}
                onSelectSection={onSelectSection}
                onDeleteStep={onDeleteStep}
                onDeleteSection={onDeleteSection}
                onRenameStep={onRenameStep}
                onRenameSection={onRenameSection}
                keyboardStepDrag={keyboardStepDrag}
                keyboardSectionDrag={keyboardSectionDrag}
                onKeyboardStepDragChange={changeKeyboardStepDrag}
                onKeyboardSectionDragChange={changeKeyboardSectionDrag}
                announce={announce}
              />
            ))}
          </Box>
        </PrimaryScrollArea>
      ) : null}
      <VisuallyHidden aria-live="polite">
        <span key={announcement.sequence}>{announcement.message}</span>
      </VisuallyHidden>
    </Stack>
  );
}
