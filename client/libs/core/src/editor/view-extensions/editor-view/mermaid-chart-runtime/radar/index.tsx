// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BarChart3Icon,
  CategoryPanelIcon,
  CommentIcon,
  TableIcon,
} from "@myoxus/icons";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Button,
  CountIndicator,
  Group,
  IconButton,
  Modal,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidRadarRendererToken,
  type MermaidFamilyReactRendererRegistration,
  type MermaidRadarCommand,
  type MermaidRadarCommandSelection,
  type MermaidRadarModel,
  type MermaidRadarReactHostProps,
  type MermaidRuntimeTransactionOptions,
} from "@virgultum/block-mermaid";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { ChartEditorSurface, stopEditorEvent } from "../common";
import {
  MermaidRadarChartSurface,
  MermaidRadarEmptyActions,
} from "./chart-surface";
import { MermaidRadarCommentMarker, MermaidRadarMorePopover } from "./comments";
import {
  MermaidRadarAxisDraft,
  MermaidRadarCurveDraft,
  MermaidRadarDataEditor,
} from "./data-editor";
import { MermaidRadarOptionsPopover } from "./options-popover";

type RadarPopover = "axis-add" | "curve-add" | "more" | "options";

function selectionExists(
  model: MermaidRadarModel,
  selection?: MermaidRadarCommandSelection,
) {
  if (
    !selection ||
    selection.kind === "diagram" ||
    selection.kind === "options"
  )
    return true;
  if (selection.kind === "axis")
    return model.axes.some((axis) => axis.id === selection.id);
  if (selection.kind === "curve")
    return model.curves.some((curve) => curve.id === selection.id);
  if (selection.kind === "comment")
    return model.comments.some((comment) => comment.id === selection.id);
  if (selection.kind !== "vertex") return false;
  return model.curves.some((curve) =>
    curve.vertices.some((vertex) => vertex.id === selection.id),
  );
}

function radarCommandNotice(
  diagnosis: string,
  labels: MermaidRadarReactHostProps["labels"],
) {
  if (diagnosis === "radar.stale-source") return labels.sourceChanged;
  if (
    diagnosis.includes("comments") ||
    diagnosis === "radar.metadata-comments-present" ||
    diagnosis === "radar.options-comments-present"
  )
    return labels.commentOwnerRemovalBlocked;
  if (diagnosis.includes("duplicate")) return labels.duplicateReference;
  if (
    diagnosis.includes("reference") ||
    diagnosis.includes("impact-unresolved") ||
    diagnosis === "radar.form-conversion-incomplete" ||
    diagnosis === "radar.vertex-gap-unresolved"
  )
    return labels.missingReference;
  if (diagnosis.includes("ambiguous") || diagnosis.includes("patch-"))
    return labels.ambiguousSource;
  return labels.invalid;
}

function RadarRuntimeBody({
  props,
}: {
  readonly props: MermaidRadarReactHostProps;
}) {
  const [selection, setSelection] = useState<
    MermaidRadarCommandSelection | undefined
  >(() => props.getRememberedSelection(props.model));
  const [dataOpen, setDataOpenState] = useState(props.initialDataOpen);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [activePopover, setActivePopover] = useState<RadarPopover>();
  const [previewModel, setPreviewModel] = useState<MermaidRadarModel>();
  const [vertexRangeLocked, setVertexRangeLocked] = useState(false);
  const [deletePending, setDeletePending] =
    useState<MermaidRadarCommandSelection>();
  const [notice, setNotice] = useState<string>();
  const sourceHashRef = useRef(props.model.sourceHash);
  const ownCommitHashRef = useRef<string | undefined>(undefined);
  const pendingFocusRef = useRef<MermaidRadarCommandSelection | undefined>(
    undefined,
  );
  const deleteFocusSelectionRef = useRef<
    MermaidRadarCommandSelection | undefined
  >(undefined);
  const lastCommittedSelectionRef = useRef<MermaidRadarCommandSelection | null>(
    null,
  );
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const runtimeRootRef = useRef<HTMLDivElement>(null);
  const setOwnedPreview = useCallback((model: MermaidRadarModel | null) => {
    setPreviewModel(model ?? undefined);
  }, []);
  const focusSelection = (
    target = selection,
    targetModel: MermaidRadarModel = props.model,
  ) => {
    if (!target) return;
    if (!("id" in target)) {
      if (target.kind !== "diagram") return;
      const label =
        targetModel.axes.length === 0
          ? props.labels.addAxis
          : targetModel.curves.length === 0
            ? props.labels.addCurve
            : null;
      if (!label) return;
      requestAnimationFrame(() =>
        Array.from(
          runtimeRootRef.current?.querySelectorAll<HTMLButtonElement>(
            "button[aria-label]",
          ) ?? [],
        )
          .find((button) => button.getAttribute("aria-label") === label)
          ?.focus(),
      );
      return;
    }
    const attribute =
      target.kind === "axis"
        ? "data-chart-axis-id"
        : target.kind === "curve"
          ? "data-chart-curve-id"
          : target.kind === "vertex"
            ? "data-chart-point-id"
            : null;
    if (!attribute) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        runtimeRootRef.current
          ?.querySelector<HTMLElement>(
            `[${attribute}="${CSS.escape(target.id)}"]`,
          )
          ?.focus(),
      ),
    );
  };
  const setDataOpen = (opened: boolean | ((current: boolean) => boolean)) => {
    setDataOpenState((current) => {
      const next = typeof opened === "function" ? opened(current) : opened;
      props.onDataOpenChange(next);
      return next;
    });
  };
  const select = (next: MermaidRadarCommandSelection, restoreFocus = false) => {
    if (restoreFocus) pendingFocusRef.current = next;
    setSelection(next);
    props.rememberSelection(props.model, next);
  };
  const dispatch = (
    command: MermaidRadarCommand | readonly MermaidRadarCommand[],
    options?: MermaidRuntimeTransactionOptions,
  ) => {
    // The Lit/Yjs commit can synchronously project new props before onCommand
    // returns. Mark the pure command projection first so that this component
    // can distinguish its own write from a concurrent source edit.
    const projected = props.onPreviewCommand(command);
    ownCommitHashRef.current = projected.changed
      ? projected.model.sourceHash
      : undefined;
    if (projected.changed && projected.selection)
      pendingFocusRef.current = projected.selection;
    const result = props.onCommand(command, options);
    if (!result.changed) {
      ownCommitHashRef.current = undefined;
      pendingFocusRef.current = undefined;
      if (result.diagnosis !== "radar.no-change")
        setNotice(radarCommandNotice(result.diagnosis, props.labels));
      return false;
    }
    ownCommitHashRef.current = result.model.sourceHash;
    lastCommittedSelectionRef.current = result.selection;
    setPreviewModel(undefined);
    setVertexRangeLocked(false);
    setNotice(undefined);
    if (result.selection) {
      setSelection(result.selection);
      props.rememberSelection(result.model, result.selection);
      const committedSelection = result.selection;
      setTimeout(() => focusSelection(committedSelection, result.model), 0);
    }
    return true;
  };
  const preview = (command: MermaidRadarCommand) => {
    const result = props.onPreviewCommand(command);
    setVertexRangeLocked(command.type === "vertex.value");
    setPreviewModel(result.changed ? result.model : undefined);
  };
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    if (ownCommitHashRef.current === props.model.sourceHash) {
      ownCommitHashRef.current = undefined;
      return;
    }
    ownCommitHashRef.current = undefined;
    setPreviewModel(undefined);
    setVertexRangeLocked(false);
    setActivePopover(undefined);
    setDeletePending(undefined);
    setNotice(props.labels.sourceChanged);
    const remembered = props.getRememberedSelection(props.model);
    setSelection((current) =>
      selectionExists(props.model, current) ? current : remembered,
    );
  }, [props]);
  useEffect(() => {
    setSelection((current) =>
      selectionExists(props.model, current) ? current : undefined,
    );
  }, [props.model]);
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || !selectionExists(props.model, pending)) return;
    pendingFocusRef.current = undefined;
    focusSelection(pending);
  }, [props.model.sourceHash, selection]);
  useEffect(() => {
    if (!props.readonly) return;
    setActivePopover(undefined);
    setDeletePending(undefined);
    setPreviewModel(undefined);
    // View suppresses the matrix without overwriting the session-local Visual
    // preference. A later Visual switch restores the user's explicit choice.
  }, [props.readonly]);
  useEffect(() => {
    if (!deletePending) return;
    const attribute =
      deletePending.kind === "axis"
        ? "data-chart-axis-id"
        : deletePending.kind === "curve"
          ? "data-chart-curve-id"
          : deletePending.kind === "vertex"
            ? "data-chart-point-id"
            : null;
    deleteReturnFocusRef.current = attribute
      ? (runtimeRootRef.current?.querySelector<HTMLElement>(
          `[${attribute}="${CSS.escape("id" in deletePending ? deletePending.id : "")}"]`,
        ) ?? null)
      : (runtimeRootRef.current?.querySelector<HTMLElement>(
          `button[aria-label="${CSS.escape(props.labels.comments)}"]`,
        ) ?? null);
  }, [deletePending, props.labels.comments, props.model.sourceHash]);
  const dataAvailable =
    props.model.axes.length > 0 && props.model.curves.length > 0;
  useEffect(() => {
    if (!dataOpen || dataAvailable) return;
    setDataOpenState(false);
    props.onDataOpenChange(false);
  }, [dataAvailable, dataOpen, props.onDataOpenChange]);

  const deleteCommand = (
    target: MermaidRadarCommandSelection,
  ): MermaidRadarCommand | null => {
    if (target.kind === "axis")
      return { axisId: target.id, type: "axis.delete" };
    if (target.kind === "curve")
      return { curveId: target.id, type: "curve.delete" };
    if (target.kind === "comment")
      return { commentId: target.id, type: "comment.delete" };
    if (target.kind === "vertex") {
      const vertex = props.model.curves
        .flatMap((curve) => curve.vertices)
        .find((candidate) => candidate.id === target.id);
      return vertex?.entryId
        ? { entryId: vertex.entryId, type: "vertex.delete" }
        : null;
    }
    return null;
  };
  const confirmDelete = () => {
    if (!deletePending) return;
    const command = deleteCommand(deletePending);
    if (command && dispatch(command)) {
      deleteFocusSelectionRef.current =
        lastCommittedSelectionRef.current ?? deletePending;
      setDeletePending(undefined);
    }
  };
  const requestDelete = (target: MermaidRadarCommandSelection) => {
    deleteFocusSelectionRef.current = target;
    deleteReturnFocusRef.current = null;
    requestAnimationFrame(() => {
      const attribute =
        target.kind === "axis"
          ? "data-chart-axis-id"
          : target.kind === "curve"
            ? "data-chart-curve-id"
            : target.kind === "vertex"
              ? "data-chart-point-id"
              : null;
      const returnTarget = attribute
        ? (runtimeRootRef.current?.querySelector<HTMLElement>(
            `[${attribute}="${CSS.escape("id" in target ? target.id : "")}"]`,
          ) ?? null)
        : (runtimeRootRef.current?.querySelector<HTMLElement>(
            `button[aria-label="${CSS.escape(props.labels.comments)}"]`,
          ) ?? null);
      deleteReturnFocusRef.current = returnTarget;
      returnTarget?.focus();
      setDeletePending(target);
    });
  };
  const cancelDelete = () => {
    setDeletePending(undefined);
  };
  const deletionDescription = () => {
    if (!deletePending) return "";
    if (deletePending.kind === "axis") {
      const axis = props.model.axes.find(
        (candidate) => candidate.id === deletePending.id,
      );
      if (!axis) return props.labels.invalid;
      return (
        <Stack gap="xs">
          <MyoxusText>
            {props.labels.deleteAxisImpact(
              axis.name,
              axis.label,
              props.model.curves.length,
            )}
          </MyoxusText>
          {props.model.curves.map((curve) => {
            const vertex = curve.vertices.find(
              (candidate) => candidate.axisId === axis.id,
            );
            return (
              <MyoxusText key={curve.id} typographySlot="caption">
                {props.labels.conversionImpact(
                  curve.label,
                  vertex?.value === undefined ? "–" : String(vertex.value),
                )}
              </MyoxusText>
            );
          })}
          {props.model.comments.filter(
            (comment) =>
              comment.anchor.kind === "axis" && comment.anchor.id === axis.id,
          ).length ? (
            <MyoxusText typographySlot="caption">
              {props.labels.commentCount(
                props.model.comments.filter(
                  (comment) =>
                    comment.anchor.kind === "axis" &&
                    comment.anchor.id === axis.id,
                ).length,
              )}
            </MyoxusText>
          ) : null}
        </Stack>
      );
    }
    if (deletePending.kind === "curve") {
      const curve = props.model.curves.find(
        (candidate) => candidate.id === deletePending.id,
      );
      if (!curve) return props.labels.invalid;
      const comments = props.model.comments.filter(
        (comment) =>
          comment.anchor.kind === "curve" && comment.anchor.id === curve.id,
      ).length;
      return props.labels.deleteCurveImpact(
        curve.name,
        curve.label,
        curve.vertices.length,
        comments,
      );
    }
    if (deletePending.kind === "vertex") {
      const command = deleteCommand(deletePending);
      const preview = command ? props.onPreviewCommand(command) : null;
      const currentCurve = props.model.curves.find((candidate) =>
        candidate.vertices.some((vertex) => vertex.id === deletePending.id),
      );
      const curve =
        preview?.changed && currentCurve
          ? preview.model.curves.find(
              (candidate) => candidate.id === currentCurve.id,
            )
          : null;
      return (
        <Stack gap="xs">
          <MyoxusText>{props.labels.deleteVertexImpact}</MyoxusText>
          {curve?.vertices.map((vertex) => {
            const axis = preview?.model.axes.find(
              (candidate) => candidate.id === vertex.axisId,
            );
            return axis ? (
              <MyoxusText key={vertex.id} typographySlot="caption">
                {props.labels.conversionImpact(
                  axis.label,
                  vertex.value === undefined ? "–" : String(vertex.value),
                )}
              </MyoxusText>
            ) : null;
          })}
        </Stack>
      );
    }
    return props.labels.delete;
  };
  const displayedModel = previewModel ?? props.model;
  const toolbar = props.readonly ? null : (
    <Group gap="xs" wrap="nowrap">
      <Popover
        fitViewport
        onChange={(opened) => setActivePopover(opened ? "axis-add" : undefined)}
        opened={activePopover === "axis-add"}
      >
        <PopoverTarget>
          <IconButton
            aria-label={props.labels.addAxis}
            icon={<CategoryPanelIcon />}
            onClick={() =>
              setActivePopover((current) =>
                current === "axis-add" ? undefined : "axis-add",
              )
            }
            tooltip={props.labels.addAxis}
            tooltipOptions={
              activePopover === "axis-add" ? { opened: false } : undefined
            }
          />
        </PopoverTarget>
        <PopoverContent>
          <Scrollable.Viewport
            autosize
            maxHeight="floating"
            offsetScrollbars="y"
          >
            <MermaidRadarAxisDraft
              onApply={(name, label, values) => {
                const applied = dispatch({
                  label,
                  name,
                  type: "axis.add",
                  values,
                });
                if (applied) setActivePopover(undefined);
                return applied;
              }}
              onCancel={() => setActivePopover(undefined)}
              props={props}
            />
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
      <Popover
        fitViewport
        onChange={(opened) =>
          setActivePopover(opened ? "curve-add" : undefined)
        }
        opened={activePopover === "curve-add"}
      >
        <PopoverTarget>
          <IconButton
            aria-label={props.labels.addCurve}
            disabled={props.model.axes.length === 0}
            icon={<BarChart3Icon />}
            onClick={() =>
              setActivePopover((current) =>
                current === "curve-add" ? undefined : "curve-add",
              )
            }
            tooltip={props.labels.addCurve}
            tooltipOptions={
              activePopover === "curve-add" ? { opened: false } : undefined
            }
          />
        </PopoverTarget>
        <PopoverContent>
          <Scrollable.Viewport
            autosize
            maxHeight="floating"
            offsetScrollbars="y"
          >
            <MermaidRadarCurveDraft
              onApply={(name, label, form, values) => {
                const applied = dispatch({
                  form,
                  label,
                  name,
                  type: "curve.add",
                  values,
                });
                if (applied) setActivePopover(undefined);
                return applied;
              }}
              onCancel={() => setActivePopover(undefined)}
              props={props}
            />
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
      <IconButton
        aria-label={props.labels.data}
        aria-pressed={dataOpen && dataAvailable}
        disabled={!dataAvailable}
        icon={<TableIcon />}
        onClick={() => {
          const opened = !dataOpen;
          setDataOpen(opened);
          if (!opened) focusSelection();
        }}
        tooltip={props.labels.data}
        variant={dataOpen ? "solid" : "plain"}
      />
      <CountIndicator count={props.model.comments.length}>
        <IconButton
          aria-label={props.labels.comments}
          aria-pressed={commentsVisible}
          icon={<CommentIcon />}
          onClick={() => setCommentsVisible((current) => !current)}
          tooltip={props.labels.comments}
          variant={commentsVisible ? "solid" : "plain"}
        />
      </CountIndicator>
      <MermaidRadarOptionsPopover
        onApplyConfig={(config) => dispatch({ config, type: "config.apply" })}
        onApplyOptions={(options) =>
          dispatch({ ...options, type: "options.apply" })
        }
        onCommentCommand={(command) => dispatch(command)}
        onOpenedChange={(opened) =>
          setActivePopover(opened ? "options" : undefined)
        }
        onPreview={setOwnedPreview}
        opened={activePopover === "options"}
        props={props}
      />
      <MermaidRadarMorePopover
        onApply={(title, description) =>
          dispatch({ description, title, type: "diagram.accessibility" })
        }
        onCommand={(command) => dispatch(command)}
        onOpenedChange={(opened) =>
          setActivePopover(opened ? "more" : undefined)
        }
        opened={activePopover === "more"}
        props={props}
      />
    </Group>
  );
  const showCommentMarkers =
    !props.displayOnly && (commentsVisible || props.readonly);
  return (
    <>
      {showCommentMarkers && props.headerActionTarget
        ? createPortal(
            <MermaidRadarCommentMarker
              anchor={{ kind: "diagram" }}
              onCommand={(command) => dispatch(command)}
              props={props}
            />,
            props.headerActionTarget,
          )
        : null}
      <div
        data-testid="mermaid-radar-view"
        onClick={props.embedded ? undefined : stopEditorEvent}
        onKeyDown={props.embedded ? undefined : stopEditorEvent}
        onMouseDown={props.embedded ? undefined : stopEditorEvent}
        onPointerDown={props.embedded ? undefined : stopEditorEvent}
        ref={runtimeRootRef}
      >
        <ChartEditorSurface
          actionTarget={props.actionTarget}
          context={undefined}
          contextOpened={false}
          contextTitle={props.labels.data}
          embedded={props.embedded}
          onCloseContext={() => undefined}
          pageViewport={props.pageViewport}
          selectedId={selection && "id" in selection ? selection.id : undefined}
          selectionAction={{
            disabled: props.readonly || !selection || !deleteCommand(selection),
            label: props.labels.delete,
            onSelect: () => selection && requestDelete(selection),
            register: props.onSelectionActionChange,
            selectionKey: selection
              ? `${selection.kind}:${"id" in selection ? selection.id : "diagram"}`
              : undefined,
          }}
          toolbar={toolbar}
          workareaLabel={props.labels.visualEditor}
        >
          <Stack gap="md">
            {notice ? (
              <Alert color="myoxusWarning" role="status" variant="light">
                {notice}
              </Alert>
            ) : null}
            <Modal
              onExitTransitionEnd={() => {
                const target = deleteFocusSelectionRef.current;
                deleteFocusSelectionRef.current = undefined;
                if (target) focusSelection(target);
              }}
              onOpenChange={(opened) => {
                if (!opened) cancelDelete();
              }}
              open={Boolean(deletePending)}
              returnFocusRef={deleteReturnFocusRef}
              title={props.labels.delete}
            >
              <Stack gap="xs">
                {deletionDescription()}
                <Group justify="flex-end">
                  <Button onClick={cancelDelete} variant="plain">
                    {props.labels.cancel}
                  </Button>
                  <Button color="myoxusError" onClick={confirmDelete}>
                    {props.labels.delete}
                  </Button>
                </Group>
              </Stack>
            </Modal>
            {displayedModel.diagnostics
              .filter(
                (diagnostic) =>
                  diagnostic.severity === "error" &&
                  (diagnostic.role === "diagram" ||
                    diagnostic.role === "config" ||
                    diagnostic.role === "option"),
              )
              .map((diagnostic) => (
                <Alert
                  color="myoxusError"
                  key={diagnostic.id}
                  role="status"
                  variant="light"
                >
                  {diagnostic.message ?? props.labels.invalid}
                </Alert>
              ))}
            <MermaidRadarChartSurface
              emptyAction={
                props.readonly ? undefined : (
                  <MermaidRadarEmptyActions
                    onAddAxis={() => setActivePopover("axis-add")}
                    onAddCurve={() => setActivePopover("curve-add")}
                    props={props}
                  />
                )
              }
              model={displayedModel}
              onCommand={(command) => dispatch(command)}
              onPreview={preview}
              onPreviewCancel={() => {
                setPreviewModel(undefined);
                setVertexRangeLocked(false);
              }}
              onRequestDelete={requestDelete}
              onSelect={(next) => select(next, true)}
              props={props}
              rangeModel={vertexRangeLocked ? props.model : displayedModel}
              selection={selection}
              showCommentMarkers={showCommentMarkers}
            />
            {!props.readonly && dataOpen && dataAvailable ? (
              <MermaidRadarDataEditor
                onDeleteEntry={(entryId) =>
                  dispatch({ entryId, type: "vertex.delete" })
                }
                onReference={(entryId, axisId) =>
                  dispatch({ axisId, entryId, type: "vertex.reference" })
                }
                onSelect={select}
                onValue={(axisId, curveId, entryId, value) => {
                  if (entryId)
                    dispatch({ entryId, type: "vertex.value", value });
                  else
                    dispatch({ axisId, curveId, type: "vertex.repair", value });
                }}
                props={props}
                selection={selection}
              />
            ) : null}
          </Stack>
        </ChartEditorSurface>
      </div>
    </>
  );
}

function RadarRuntimeFallback({
  props,
  resetErrorBoundary,
}: FallbackProps & { readonly props: MermaidRadarReactHostProps }) {
  return (
    <Alert color="myoxusError" role="alert" variant="light">
      <Stack gap="xs">
        <MyoxusText>{props.labels.rendererError}</MyoxusText>
        <Group>
          <Button onClick={resetErrorBoundary}>{props.labels.retry}</Button>
          {props.embedded ? null : (
            <Button onClick={props.onOpenSource} variant="plain">
              {props.labels.source}
            </Button>
          )}
        </Group>
      </Stack>
    </Alert>
  );
}

export function MermaidRadarRuntime({
  props,
}: {
  readonly props: MermaidRadarReactHostProps;
}) {
  return (
    <ErrorBoundary
      fallbackRender={(fallbackProps) => (
        <RadarRuntimeFallback {...fallbackProps} props={props} />
      )}
      resetKeys={[props.model.sourceHash]}
    >
      <RadarRuntimeBody props={props} />
    </ErrorBoundary>
  );
}

export function createMermaidRadarRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidRadarReactHostProps> {
  return {
    token: mermaidRadarRendererToken,
    render: (props) => reactToLit(<MermaidRadarRuntime props={props} />, true),
  };
}
