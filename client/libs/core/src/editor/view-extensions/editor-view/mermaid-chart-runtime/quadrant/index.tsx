// SPDX-License-Identifier: AGPL-3.0-or-later

import { CommentIcon, PlusIcon, TableIcon } from "@myoxus/icons";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Group,
  IconButton,
  Stack,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import {
  mermaidQuadrantRendererToken,
  type MermaidFamilyReactRendererRegistration,
  type MermaidQuadrantCommand,
  type MermaidQuadrantConfig,
  type MermaidQuadrantPoint,
  type MermaidQuadrantReactHostProps,
  type MermaidRuntimeTransactionOptions,
} from "@virgultum/block-mermaid";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ChartEditorSurface, stopEditorEvent } from "../common";
import { MermaidQuadrantChartSurface } from "./chart-surface";
import { MermaidQuadrantComments } from "./comments";
import { MermaidQuadrantDataEditor } from "./data-editor";
import {
  MermaidQuadrantMorePopover,
  MermaidQuadrantSettingsPopover,
} from "./settings-popover";

const QUADRANT_DRAFT_POINT_ID = "quadrant-point-draft";

function QuadrantControlBoundary({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div
      data-mermaid-quadrant-control="true"
      onClick={stopEditorEvent}
      onKeyDown={stopEditorEvent}
      onMouseDown={stopEditorEvent}
      onPointerDown={stopEditorEvent}
    >
      {children}
    </div>
  );
}

export function MermaidQuadrantRuntime({
  props,
}: {
  readonly props: MermaidQuadrantReactHostProps;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [editor, setEditor] = useState<"coordinates" | "label" | null>(null);
  const [draft, setDraft] = useState<MermaidQuadrantPoint | null>(null);
  const [dataEditorOpen, setDataEditorOpen] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [appearancePreview, setAppearancePreview] =
    useState<MermaidQuadrantConfig | null>(null);
  const [pointAppearancePreview, setPointAppearancePreview] = useState<{
    readonly className?: string;
    readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
    readonly reorderDirection?: -1 | 1;
  } | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [notice, setNotice] = useState<string>();
  const sourceHashRef = useRef(props.model.sourceHash);
  const ownCommitPendingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    if (ownCommitPendingRef.current) {
      ownCommitPendingRef.current = false;
      return;
    }
    if (
      editor ||
      draft ||
      dataEditorOpen ||
      appearancePreview ||
      pointAppearancePreview
    ) {
      setEditor(null);
      setDraft(null);
      setNotice(props.labels.sourceChanged);
      setAppearancePreview(null);
      setPointAppearancePreview(null);
    }
  }, [
    dataEditorOpen,
    appearancePreview,
    draft,
    editor,
    pointAppearancePreview,
    props.labels.sourceChanged,
    props.model.sourceHash,
  ]);
  useEffect(() => {
    if (!props.readonly) return;
    setSelectedId(undefined);
    setEditor(null);
    setDraft(null);
    setAppearancePreview(null);
    setPointAppearancePreview(null);
  }, [props.readonly]);
  useEffect(() => {
    if (
      selectedId &&
      selectedId !== QUADRANT_DRAFT_POINT_ID &&
      !props.model.points.some((point) => point.id === selectedId)
    ) {
      setSelectedId(undefined);
      setEditor(null);
    }
  }, [props.model.points, selectedId]);
  const dispatch = (
    command: MermaidQuadrantCommand | readonly MermaidQuadrantCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => {
    const selection = props.onCommand(command, options);
    if (selection) {
      ownCommitPendingRef.current = true;
      setNotice(undefined);
    }
    if (selection?.kind === "point") setSelectedId(selection.id);
    else if (selection) setSelectedId(undefined);
    return selection;
  };
  const previewPointAppearance = useCallback(
    (
      preview: {
        readonly className?: string;
        readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
        readonly reorderDirection?: -1 | 1;
      } | null,
    ) => setPointAppearancePreview(preview),
    [],
  );
  const select = (id: string) => {
    if (draft && id !== draft.id) setDraft(null);
    setSelectedId(id);
  };
  const focusSelectedPoint = () => {
    const target = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>(
        "[data-chart-point-id]",
      ) ?? []),
    ].find((element) => element.dataset.chartPointId === selectedId);
    target?.focus({ preventScroll: true });
  };
  const startDraft = () => {
    const next: MermaidQuadrantPoint = {
      id: QUADRANT_DRAFT_POINT_ID,
      inlineStyle: {},
      label: props.labels.add,
      labelForm: "plain",
      order: props.model.points.length,
      runtimePaintOrder: 0,
      sourceFingerprint: "",
      sourceRecordId: "",
      x: 0.5,
      y: 0.5,
    };
    setDraft(next);
    setSelectedId(next.id);
    setEditor("label");
  };
  const deletePoint = (id: string) => {
    if (id === QUADRANT_DRAFT_POINT_ID) {
      setDraft(null);
      setEditor(null);
      setSelectedId(undefined);
      return;
    }
    dispatch({ pointId: id, type: "point.delete" });
    setEditor(null);
    setPointAppearancePreview(null);
  };
  const applyPoint = (
    point: MermaidQuadrantPoint,
    draftValue: {
      className?: string;
      inlineStyle: MermaidQuadrantPoint["inlineStyle"];
      label: string;
      labelForm: MermaidQuadrantPoint["labelForm"];
      reorderDirection?: -1 | 1;
      x: number;
      y: number;
    },
  ) => {
    const { className, inlineStyle, label, labelForm, reorderDirection, x, y } =
      draftValue;
    if (point.id === QUADRANT_DRAFT_POINT_ID) {
      const selection = dispatch({
        className,
        inlineStyle,
        label,
        labelForm,
        type: "point.add",
        x,
        y,
      });
      if (!selection) return false;
      setDraft(null);
      setEditor(null);
      return true;
    }
    const commands: MermaidQuadrantCommand[] = [];
    if (label.trim() !== point.label) {
      commands.push({ label, pointId: point.id, type: "point.rename" });
    }
    if (labelForm !== point.labelForm) {
      commands.push({
        form: labelForm,
        pointId: point.id,
        type: "point.label-form",
      });
    }
    if (x !== point.x || y !== point.y) {
      commands.push({ pointId: point.id, type: "point.move", x, y });
    }
    if (className !== point.className) {
      commands.push({ className, pointId: point.id, type: "point.class" });
    }
    if (JSON.stringify(inlineStyle) !== JSON.stringify(point.inlineStyle)) {
      commands.push({
        pointId: point.id,
        style: inlineStyle,
        type: "appearance.point-style",
      });
    }
    if (reorderDirection) {
      const index = props.model.points.findIndex(
        (candidate) => candidate.id === point.id,
      );
      const target = index + reorderDirection;
      if (index >= 0 && target >= 0 && target < props.model.points.length) {
        commands.push({
          beforePointId:
            reorderDirection < 0
              ? props.model.points[target].id
              : props.model.points[target + 1]?.id,
          pointId: point.id,
          type: "point.reorder",
        });
      }
    }
    const applied = commands.length === 0 || Boolean(dispatch(commands));
    if (applied) setEditor(null);
    return applied;
  };
  const reorder = (pointId: string, beforePointId?: string) =>
    dispatch({ beforePointId, pointId, type: "point.reorder" });
  const reorderByDirection = (pointId: string, direction: -1 | 1) => {
    const index = props.model.points.findIndex((point) => point.id === pointId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= props.model.points.length) return;
    reorder(
      pointId,
      direction < 0
        ? props.model.points[target].id
        : props.model.points[target + 1]?.id,
    );
  };
  return (
    <div
      data-testid="mermaid-quadrant-view"
      ref={rootRef}
      onClick={props.embedded ? undefined : stopEditorEvent}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const focusedPointId = target.dataset.chartPointId;
        if (
          !props.readonly &&
          selectedId &&
          focusedPointId === selectedId &&
          (event.key === "Delete" || event.key === "Backspace")
        ) {
          event.preventDefault();
          event.stopPropagation();
          deletePoint(selectedId);
        }
        if (!props.embedded) stopEditorEvent(event);
      }}
      onMouseDown={props.embedded ? undefined : stopEditorEvent}
      onPointerDown={props.embedded ? undefined : stopEditorEvent}
    >
      <ChartEditorSurface
        actionTarget={props.actionTarget}
        context={null}
        contextOpened={false}
        contextTitle={props.labels.more}
        embedded={props.embedded}
        onCloseContext={() => {
          setSelectedId(undefined);
          setEditor(null);
        }}
        pageViewport={props.pageViewport}
        selectedId={selectedId}
        selectionAction={{
          disabled: props.readonly,
          label: props.labels.delete,
          onSelect: () => selectedId && deletePoint(selectedId),
          register: props.onSelectionActionChange,
        }}
        toolbar={
          props.readonly ? null : (
            <Group gap="xs" role="group" wrap="nowrap">
              <IconButton
                aria-label={props.labels.add}
                icon={<PlusIcon />}
                onClick={startDraft}
                tooltip={props.labels.add}
              />
              <IconButton
                aria-label={props.labels.data}
                aria-pressed={dataEditorOpen}
                icon={<TableIcon />}
                onClick={() =>
                  setDataEditorOpen((current) => {
                    if (current) queueMicrotask(focusSelectedPoint);
                    return !current;
                  })
                }
                tooltip={props.labels.data}
                variant={dataEditorOpen ? "solid" : "plain"}
              />
              <IconButton
                aria-label={props.labels.comments}
                aria-pressed={commentsVisible}
                icon={<CommentIcon />}
                onClick={() => setCommentsVisible((current) => !current)}
                tooltip={props.labels.comments}
                variant={commentsVisible ? "solid" : "plain"}
              />
              <MermaidQuadrantSettingsPopover
                onApply={(input) => {
                  const commands: MermaidQuadrantCommand[] = [];
                  if (
                    input.xAxis[0] !== props.model.xAxisStart ||
                    input.xAxis[1] !== props.model.xAxisEnd ||
                    input.xAxisForm !== props.model.axes.x.form ||
                    input.xAxisTextForms[0] !== props.model.axes.x.startForm ||
                    input.xAxisTextForms[1] !== props.model.axes.x.endForm
                  ) {
                    commands.push({
                      axis: "x",
                      end: input.xAxis[1],
                      endForm: input.xAxisTextForms[1],
                      form: input.xAxisForm,
                      start: input.xAxis[0],
                      startForm: input.xAxisTextForms[0],
                      type: "text.axis",
                    });
                  }
                  if (
                    input.yAxis[0] !== props.model.yAxisStart ||
                    input.yAxis[1] !== props.model.yAxisEnd ||
                    input.yAxisForm !== props.model.axes.y.form ||
                    input.yAxisTextForms[0] !== props.model.axes.y.startForm ||
                    input.yAxisTextForms[1] !== props.model.axes.y.endForm
                  ) {
                    commands.push({
                      axis: "y",
                      end: input.yAxis[1],
                      endForm: input.yAxisTextForms[1],
                      form: input.yAxisForm,
                      start: input.yAxis[0],
                      startForm: input.yAxisTextForms[0],
                      type: "text.axis",
                    });
                  }
                  input.quadrantLabels.forEach((text, index) => {
                    if (
                      text === props.model.quadrantLabels[index] &&
                      input.quadrantForms[index] ===
                        props.model.quadrantTexts[index].form
                    )
                      return;
                    commands.push({
                      form: input.quadrantForms[index],
                      quadrant: (index + 1) as 1 | 2 | 3 | 4,
                      text,
                      type: "text.quadrant",
                    });
                  });
                  if (
                    JSON.stringify(input.config) !==
                    JSON.stringify(props.model.config)
                  ) {
                    commands.push({
                      config: input.config,
                      type: "appearance.config",
                    });
                  }
                  return commands.length === 0 || Boolean(dispatch(commands));
                }}
                onClassCommand={(command) => Boolean(dispatch(command))}
                onCommand={(command) => Boolean(dispatch(command))}
                onPreview={setAppearancePreview}
                onStale={() => setNotice(props.labels.sourceChanged)}
                props={props}
              />
              <MermaidQuadrantMorePopover
                onApply={(title, description) =>
                  title === props.model.accessibilityTitle &&
                  description === props.model.accessibilityDescription
                    ? true
                    : Boolean(
                        dispatch({
                          description,
                          title,
                          type: "diagram.accessibility",
                        }),
                      )
                }
                props={props}
              />
            </Group>
          )
        }
        workareaLabel={props.labels.chart}
      >
        <Stack gap="md">
          {notice ? (
            <Alert color="myoxusWarning" role="status" variant="light">
              {notice}
            </Alert>
          ) : null}
          <MermaidQuadrantChartSurface
            commentsVisible={commentsVisible && !props.readonly}
            draft={draft}
            editor={editor}
            onAdd={startDraft}
            onDraftMove={(x, y) =>
              setDraft((current) => (current ? { ...current, x, y } : current))
            }
            onDraftInvalidated={() => setNotice(props.labels.sourceChanged)}
            onCommentCommand={(command) => Boolean(dispatch(command))}
            onEditorClose={() => {
              setEditor(null);
              setPointAppearancePreview(null);
              if (draft) {
                setDraft(null);
                setSelectedId(undefined);
              }
            }}
            onEditorOpen={(mode, id) => {
              select(id);
              setEditor(mode);
            }}
            onPointApply={applyPoint}
            onPointAppearancePreview={previewPointAppearance}
            onPointDelete={deletePoint}
            onPointReorder={reorderByDirection}
            onMove={(id, x, y) =>
              Boolean(dispatch({ pointId: id, type: "point.move", x, y }))
            }
            onMovePreview={(id, x, y) => {
              if (id === undefined || x === undefined || y === undefined) {
                setMoveAnnouncement("");
                return;
              }
              const format = new Intl.NumberFormat(undefined, {
                maximumFractionDigits: 4,
              });
              setMoveAnnouncement(
                `${props.labels.x} ${format.format(x)}, ${props.labels.y} ${format.format(y)}`,
              );
            }}
            onSelect={select}
            onTextApply={(id, value) => {
              if (id.startsWith("quadrant-")) {
                const quadrant = Number(id.slice("quadrant-".length)) as
                  1 | 2 | 3 | 4;
                return Boolean(
                  dispatch({
                    form: props.model.quadrantTexts[quadrant - 1].form,
                    quadrant,
                    text: value,
                    type: "text.quadrant",
                  }),
                );
              }
              const axis = id.startsWith("x-") ? "x" : "y";
              const current = props.model.axes[axis];
              return Boolean(
                dispatch({
                  axis,
                  end: id.endsWith("-end") ? value : current.end,
                  endForm: current.endForm,
                  start: id.endsWith("-start") ? value : current.start,
                  startForm: current.startForm,
                  type: "text.axis",
                }),
              );
            }}
            appearancePreview={appearancePreview}
            pointAppearancePreview={pointAppearancePreview}
            props={props}
            selectedId={selectedId}
          />
          {commentsVisible && !props.readonly ? (
            <QuadrantControlBoundary>
              <MermaidQuadrantComments
                anchor={{ kind: "diagram" }}
                onCommand={(command) => Boolean(dispatch(command))}
                onDraftInvalidated={() => setNotice(props.labels.sourceChanged)}
                props={props}
              />
            </QuadrantControlBoundary>
          ) : null}
          <VisuallyHidden aria-live="polite">{moveAnnouncement}</VisuallyHidden>
          {dataEditorOpen && !props.readonly ? (
            <QuadrantControlBoundary>
              <MermaidQuadrantDataEditor
                onAdd={startDraft}
                onDelete={deletePoint}
                onMove={(id, x, y) =>
                  Boolean(dispatch({ pointId: id, type: "point.move", x, y }))
                }
                onRename={(id, label) =>
                  Boolean(
                    dispatch({ label, pointId: id, type: "point.rename" }),
                  )
                }
                onReorder={reorder}
                onSelect={select}
                props={props}
                selectedId={selectedId}
              />
            </QuadrantControlBoundary>
          ) : null}
        </Stack>
      </ChartEditorSurface>
    </div>
  );
}

export function createMermaidQuadrantRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidQuadrantReactHostProps> {
  return {
    token: mermaidQuadrantRendererToken,
    render: (props) =>
      reactToLit(<MermaidQuadrantRuntime props={props} />, true),
  };
}
