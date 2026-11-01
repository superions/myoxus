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
  Group,
  IconButton,
  localizedChartNumber,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import {
  DEFAULT_MERMAID_XY_CONFIG,
  mermaidXyRendererToken,
  type MermaidFamilyReactRendererRegistration,
  type MermaidRuntimeTransactionOptions,
  type MermaidXyCommand,
  type MermaidXyConfig,
  type MermaidXyModel,
  type MermaidXyPoint,
  type MermaidXyReactHostProps,
  type MermaidXyTextForm,
} from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { ChartEditorSurface, stopEditorEvent } from "../common";
import { MermaidXyAppearancePopover } from "./appearance-popover";
import { MermaidXyAxisPopover } from "./axis-popover";
import { MermaidXyChartSurface } from "./chart-surface";
import {
  MermaidXyAccessibilityPopover,
  MermaidXyCommentMarker,
} from "./comments";
import {
  MermaidXyCategoryDraft,
  MermaidXyDataEditor,
  MermaidXyEmptyActions,
  MermaidXyPlotDraft,
} from "./data-editor";
import type { MermaidXyEditorDraft } from "./value-popover";

function MermaidXyRuntimeBody({
  props,
}: {
  readonly props: MermaidXyReactHostProps;
}) {
  const getRememberedSelection = props.getRememberedSelection;
  const model = props.model;
  const sourceChangedLabel = props.labels.sourceChanged;
  const initialSelection = useRef(getRememberedSelection(model));
  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialSelection.current,
  );
  const [editingId, setEditingId] = useState<string>();
  const [editorDraft, setEditorDraft] = useState<MermaidXyEditorDraft>();
  const [preview, setPreview] = useState<{ id: string; y: number }>();
  const [appearancePreview, setAppearancePreview] = useState<MermaidXyConfig>();
  const [structuralPreview, setStructuralPreview] = useState<MermaidXyModel>();
  const [dataOpen, setDataOpenState] = useState(props.initialDataOpen);
  const dataOpenRef = useRef(dataOpen);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activePopover, setActivePopover] = useState<
    "accessibility" | "appearance" | "axis" | "category" | "plot"
  >();
  const [deletePending, setDeletePending] = useState<string>();
  const [focusRequestKey, setFocusRequestKey] = useState<number | undefined>(
    initialSelection.current === undefined ? undefined : 1,
  );
  const [notice, setNotice] = useState<string>();
  const sourceHashRef = useRef(model.sourceHash);
  const ownCommitHashRef = useRef<string | undefined>(undefined);
  const focusRequestFrameRef = useRef<number | undefined>(undefined);
  const requestChartFocus = () => {
    if (focusRequestFrameRef.current !== undefined)
      cancelAnimationFrame(focusRequestFrameRef.current);
    focusRequestFrameRef.current = requestAnimationFrame(() => {
      focusRequestFrameRef.current = undefined;
      setFocusRequestKey((key) => (key ?? 0) + 1);
    });
  };
  const selectChartElement = (id: string) => {
    if (id !== selectedId) setSelectedId(id);
    props.rememberSelection(props.model, id);
    requestChartFocus();
  };
  const selectDataElement = (id: string) => {
    if (id !== selectedId) setSelectedId(id);
    props.rememberSelection(props.model, id);
  };
  useEffect(
    () => () => {
      if (focusRequestFrameRef.current !== undefined)
        cancelAnimationFrame(focusRequestFrameRef.current);
    },
    [],
  );
  const setDataOpen = (opened: boolean | ((current: boolean) => boolean)) => {
    setDataOpenState((current) => {
      const next = typeof opened === "function" ? opened(current) : opened;
      props.onDataOpenChange(next);
      return next;
    });
  };
  useEffect(() => {
    const closed = dataOpenRef.current && !dataOpen;
    dataOpenRef.current = dataOpen;
    if (closed && selectedId) setFocusRequestKey((key) => (key ?? 0) + 1);
  }, [dataOpen, selectedId]);
  useEffect(() => {
    if (sourceHashRef.current === model.sourceHash) return;
    sourceHashRef.current = model.sourceHash;
    if (ownCommitHashRef.current === model.sourceHash) {
      ownCommitHashRef.current = undefined;
      return;
    }
    ownCommitHashRef.current = undefined;
    const draftInvalidated = Boolean(
      editingId ||
      preview ||
      appearancePreview ||
      structuralPreview ||
      activePopover !== undefined ||
      deletePending,
    );
    if (draftInvalidated) {
      setEditingId(undefined);
      setEditorDraft(undefined);
      setPreview(undefined);
      setAppearancePreview(undefined);
      setStructuralPreview(undefined);
      setActivePopover(undefined);
      setDeletePending(undefined);
      setNotice(sourceChangedLabel);
    }
    const restoredSelection = getRememberedSelection(model);
    if (restoredSelection !== undefined) setSelectedId(restoredSelection);
    if (restoredSelection ?? selectedId)
      setFocusRequestKey((key) => (key ?? 0) + 1);
  }, [
    appearancePreview,
    structuralPreview,
    activePopover,
    editingId,
    preview,
    deletePending,
    sourceChangedLabel,
    model,
    selectedId,
    getRememberedSelection,
  ]);
  useEffect(() => {
    const exists = props.model.plots.some(
      (plot) =>
        plot.id === selectedId ||
        plot.points.some((point) => point.id === selectedId),
    );
    const categoryExists = props.model.xAxis.categories.some(
      (category) => category.id === selectedId,
    );
    const axisExists = selectedId === "xy-axis-x" || selectedId === "xy-axis-y";
    if (selectedId && !exists && !categoryExists && !axisExists)
      setSelectedId(undefined);
  }, [props.model.plots, props.model.xAxis.categories, selectedId]);
  useEffect(() => {
    if (!props.readonly) return;
    setEditingId(undefined);
    setEditorDraft(undefined);
    setPreview(undefined);
    setAppearancePreview(undefined);
    setStructuralPreview(undefined);
    setDeletePending(undefined);
    setActivePopover(undefined);
  }, [props.readonly]);
  const dispatch = (
    command: MermaidXyCommand | readonly MermaidXyCommand[],
    options?: MermaidRuntimeTransactionOptions,
    preserveSelection = false,
  ) => {
    props.rememberSelection(props.model, selectedId);
    const result = props.onCommand(command, options);
    const selectedStillExists =
      selectedId === "xy-axis-x" ||
      selectedId === "xy-axis-y" ||
      result.model.xAxis.categories.some(
        (category) => category.id === selectedId,
      ) ||
      result.model.plots.some(
        (plot) =>
          plot.id === selectedId ||
          plot.points.some((point) => point.id === selectedId),
      );
    const selection =
      result.changed && preserveSelection && selectedId && selectedStillExists
        ? selectedId === "xy-axis-x"
          ? ({ id: selectedId, kind: "x-axis" } as const)
          : selectedId === "xy-axis-y"
            ? ({ id: selectedId, kind: "y-axis" } as const)
            : result.model.xAxis.categories.some(
                  (category) => category.id === selectedId,
                )
              ? ({ id: selectedId, kind: "category" } as const)
              : result.model.plots.some((plot) => plot.id === selectedId)
                ? ({ id: selectedId, kind: "plot" } as const)
                : ({ id: selectedId, kind: "point" } as const)
        : result.selection;
    if (result.changed && selection) {
      props.rememberSelection(
        result.model,
        selection.kind === "diagram" ? undefined : selection.id,
      );
      ownCommitHashRef.current = result.model.sourceHash;
      setNotice(undefined);
      if (
        selection.kind === "plot" ||
        selection.kind === "point" ||
        selection.kind === "category" ||
        selection.kind === "x-axis" ||
        selection.kind === "y-axis"
      )
        setSelectedId(selection.id);
      else if (selection.kind === "diagram") setSelectedId(undefined);
    } else if (result.changed) {
      props.rememberSelection(result.model, undefined);
    } else {
      const message = props.labels.commandFailure(result.diagnosis);
      if (message) setNotice(message);
    }
    return selection;
  };
  const pointById = (id: string) =>
    props.model.plots
      .flatMap((plot) => plot.points)
      .find((point) => point.id === id);
  const plotLabel = (plot: (typeof props.model.plots)[number]) =>
    plot.titleExplicit
      ? plot.title
      : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`;
  const beginEdit = (id: string) => {
    const point = pointById(id);
    const plot = props.model.plots.find((candidate) => candidate.id === id);
    const category = props.model.xAxis.categories.find(
      (candidate) => candidate.id === id,
    );
    setEditorDraft(
      point
        ? {
            id,
            kind: "point",
            label: point.label,
            labelForm: point.labelForm ?? "plain",
            reorderDirection: 0,
            value: point.value,
          }
        : plot
          ? {
              id,
              kind: "plot",
              plotKind: plot.kind,
              reorderDirection: 0,
              title: plot.titleExplicit ? plot.title : "",
              titleForm: plot.titleForm ?? "plain",
            }
          : category
            ? {
                id,
                kind: "category",
                label: category.label,
                reorderDirection: 0,
              }
            : undefined,
    );
    setEditingId(id);
  };
  const requestDelete = (id: string) => {
    const point = pointById(id);
    if (
      point &&
      props.model.plots.find((plot) => plot.id === point.plotId)?.points
        .length === 1
    ) {
      setNotice(props.labels.commandFailure("xy.plot-point-minimum"));
      return;
    }
    const category = props.model.xAxis.categories.find(
      (candidate) => candidate.id === id,
    );
    if (
      category &&
      (props.model.xAxis.categories.length === 1 ||
        (category.order === 0 &&
          props.model.plots.some((plot) => plot.points.length === 1)))
    ) {
      setNotice(props.labels.commandFailure("xy.category-minimum"));
      return;
    }
    setStructuralPreview(undefined);
    setEditingId(undefined);
    setEditorDraft(undefined);
    setDeletePending(id);
  };
  const deleteDescription = () => {
    if (!deletePending) return "";
    const point = pointById(deletePending);
    if (point) {
      const plot = props.model.plots.find(
        (candidate) => candidate.id === point.plotId,
      )!;
      return props.model.xAxis.effectiveKind === "band"
        ? props.labels.deletePointImpact(
            plotLabel(plot),
            point.order + 1,
            Math.max(0, plot.points.length - point.order - 1),
          )
        : props.labels.deleteLinearPointImpact(
            plotLabel(plot),
            point.order + 1,
            Math.max(0, plot.points.length - 1),
          );
    }
    const plot = props.model.plots.find(
      (candidate) => candidate.id === deletePending,
    );
    if (plot)
      return props.labels.deletePlotImpact(
        plotLabel(plot),
        plot.kind === "bar" ? props.labels.bar : props.labels.line,
        plot.points.length,
      );
    const category = props.model.xAxis.categories.find(
      (candidate) => candidate.id === deletePending,
    );
    return category
      ? props.labels.deleteCategoryImpact(
          category.label,
          props.model.plots.filter(
            (candidate) => candidate.points.length > category.order,
          ).length,
        )
      : props.labels.delete;
  };
  const deleteCategoryDetails = () => {
    const category = props.model.xAxis.categories.find(
      (candidate) => candidate.id === deletePending,
    );
    if (!category) return [];
    return props.model.plots.map((plot) => {
      const point = plot.points[category.order];
      const label = plotLabel(plot);
      const value = point
        ? `${localizedChartNumber(point.value)}${point.label ? ` · ${point.label}` : ""}`
        : null;
      return {
        id: plot.id,
        text: value
          ? props.labels.deleteCategoryPlotValue(label, value)
          : props.labels.deleteCategoryPlotMissing(label),
      };
    });
  };
  const confirmDelete = () => {
    if (!deletePending) return;
    const point = pointById(deletePending);
    const plot = props.model.plots.find(
      (candidate) => candidate.id === deletePending,
    );
    const category = props.model.xAxis.categories.find(
      (candidate) => candidate.id === deletePending,
    );
    const selection = point
      ? dispatch({ pointId: point.id, type: "point.delete" })
      : plot
        ? dispatch({ plotId: plot.id, type: "plot.delete" })
        : category
          ? dispatch({
              categoryId: category.id,
              confirmAffectedPlotIds: props.model.plots
                .filter((candidate) => candidate.points.length > category.order)
                .map((candidate) => candidate.id),
              type: "category.delete",
            })
          : null;
    if (selection) {
      setDeletePending(undefined);
      setEditingId(undefined);
      setEditorDraft(undefined);
      setFocusRequestKey((key) => (key ?? 0) + 1);
    }
  };
  const cancelDelete = () => {
    setDeletePending(undefined);
    setFocusRequestKey((key) => (key ?? 0) + 1);
  };
  const applyPoint = (
    point: MermaidXyPoint,
    value: number,
    label: string,
    labelForm: MermaidXyTextForm,
    reorderDirection: -1 | 0 | 1,
  ) => {
    const commands: MermaidXyCommand[] = [];
    if (value !== point.value)
      commands.push({ pointId: point.id, type: "point.value", value });
    if (label !== point.label)
      commands.push({
        label,
        labelForm,
        pointId: point.id,
        type: "point.label",
      });
    else if (label && labelForm !== point.labelForm)
      commands.push({ labelForm, pointId: point.id, type: "point.label-form" });
    const reorder = reorderPointCommand(point.id, reorderDirection);
    if (reorder) commands.push(reorder);
    const applied = commands.length === 0 || Boolean(dispatch(commands));
    if (applied) {
      setEditingId(undefined);
      setEditorDraft(undefined);
      setStructuralPreview(undefined);
      if (commands.length > 0) requestChartFocus();
    }
    return applied;
  };
  const reorderPointCommand = (
    pointId: string,
    direction: -1 | 0 | 1,
  ): MermaidXyCommand | null => {
    if (!direction) return null;
    const plot = props.model.plots.find((candidate) =>
      candidate.points.some((point) => point.id === pointId),
    );
    if (!plot) return null;
    const index = plot.points.findIndex((point) => point.id === pointId);
    const target = index + direction;
    if (target < 0 || target >= plot.points.length) return null;
    return {
      beforePointId:
        direction < 0 ? plot.points[target].id : plot.points[target + 1]?.id,
      pointId,
      type: "point.reorder",
    };
  };
  const reorderPoint = (pointId: string, direction: -1 | 1) => {
    const command = reorderPointCommand(pointId, direction);
    if (command) dispatch(command);
  };
  const reorderPlotCommand = (
    plotId: string,
    direction: -1 | 0 | 1,
  ): MermaidXyCommand | null => {
    if (!direction) return null;
    const index = props.model.plots.findIndex((plot) => plot.id === plotId);
    const target = index + direction;
    if (target < 0 || target >= props.model.plots.length) return null;
    return {
      beforePlotId:
        direction < 0
          ? props.model.plots[target].id
          : props.model.plots[target + 1]?.id,
      plotId,
      type: "plot.reorder",
    };
  };
  const reorderCategoryCommand = (
    categoryId: string,
    direction: -1 | 0 | 1,
  ): MermaidXyCommand | null => {
    if (!direction) return null;
    const index = props.model.xAxis.categories.findIndex(
      (category) => category.id === categoryId,
    );
    const target = index + direction;
    if (target < 0 || target >= props.model.xAxis.categories.length)
      return null;
    return {
      beforeCategoryId:
        direction < 0
          ? props.model.xAxis.categories[target].id
          : props.model.xAxis.categories[target + 1]?.id,
      categoryId,
      type: "category.reorder",
    };
  };
  const reorderPlot = (plotId: string, direction: -1 | 1) => {
    const command = reorderPlotCommand(plotId, direction);
    if (command) dispatch(command);
  };
  const reorderCategory = (categoryId: string, direction: -1 | 1) => {
    const command = reorderCategoryCommand(categoryId, direction);
    if (command) dispatch(command);
  };
  const previewReorder = (
    kind: "category" | "plot" | "point",
    id: string,
    direction: -1 | 1 | null,
  ) => {
    if (!direction) {
      setStructuralPreview(undefined);
      return;
    }
    const command =
      kind === "point"
        ? reorderPointCommand(id, direction)
        : kind === "plot"
          ? reorderPlotCommand(id, direction)
          : reorderCategoryCommand(id, direction);
    if (!command) return;
    const result = props.onPreviewCommand(command);
    if (result.changed) {
      setStructuralPreview(result.model);
      setNotice(undefined);
    } else {
      setStructuralPreview(undefined);
      const message = props.labels.commandFailure(result.diagnosis);
      if (message) setNotice(message);
    }
  };
  const commitReorder = (
    kind: "category" | "plot" | "point",
    id: string,
    direction: -1 | 1,
  ) => {
    const command =
      kind === "point"
        ? reorderPointCommand(id, direction)
        : kind === "plot"
          ? reorderPlotCommand(id, direction)
          : reorderCategoryCommand(id, direction);
    setStructuralPreview(undefined);
    if (command && dispatch(command)) requestChartFocus();
  };
  const toolbar = props.readonly ? null : (
    <Group
      gap="xs"
      onPointerDownCapture={() => setNotice(undefined)}
      role="group"
      wrap="nowrap"
    >
      <Popover
        onChange={(opened) => setActivePopover(opened ? "plot" : undefined)}
        opened={activePopover === "plot"}
      >
        <PopoverTarget>
          <IconButton
            aria-label={props.labels.addPlot}
            icon={<BarChart3Icon />}
            onClick={() =>
              setActivePopover((value) =>
                value === "plot" ? undefined : "plot",
              )
            }
            tooltip={props.labels.addPlot}
          />
        </PopoverTarget>
        <PopoverContent>
          <MermaidXyPlotDraft
            onApply={(kind, title, points) => {
              if (dispatch({ kind, points, title, type: "plot.add" }))
                setActivePopover(undefined);
            }}
            onCancel={() => setActivePopover(undefined)}
            props={props}
          />
        </PopoverContent>
      </Popover>
      {props.model.xAxis.effectiveKind === "band" ? (
        <Popover
          onChange={(opened) =>
            setActivePopover(opened ? "category" : undefined)
          }
          opened={activePopover === "category"}
        >
          <PopoverTarget>
            <IconButton
              aria-label={props.labels.addCategory}
              icon={<CategoryPanelIcon />}
              onClick={() =>
                setActivePopover((value) =>
                  value === "category" ? undefined : "category",
                )
              }
              tooltip={props.labels.addCategory}
            />
          </PopoverTarget>
          <PopoverContent>
            <MermaidXyCategoryDraft
              onApply={(label, values) => {
                if (dispatch({ label, type: "category.add", values }))
                  setActivePopover(undefined);
              }}
              onCancel={() => setActivePopover(undefined)}
              props={props}
            />
          </PopoverContent>
        </Popover>
      ) : null}
      <IconButton
        aria-label={props.labels.data}
        aria-pressed={dataOpen}
        icon={<TableIcon />}
        onClick={() => setDataOpen((value) => !value)}
        tooltip={props.labels.data}
        variant={dataOpen ? "solid" : "plain"}
      />
      <IconButton
        aria-label={props.labels.comments}
        aria-pressed={commentsOpen}
        icon={<CommentIcon />}
        onClick={() => setCommentsOpen((value) => !value)}
        tooltip={props.labels.comments}
        variant={commentsOpen ? "solid" : "plain"}
      />
      <MermaidXyAxisPopover
        onApply={(commands) => Boolean(dispatch(commands))}
        onOpenedChange={(opened) =>
          setActivePopover(opened ? "axis" : undefined)
        }
        opened={activePopover === "axis"}
        props={props}
      />
      <MermaidXyAppearancePopover
        onApply={(config) => {
          const commands: MermaidXyCommand[] = [];
          const currentConfig = {
            ...DEFAULT_MERMAID_XY_CONFIG,
            ...props.model.config,
            xAxis: {
              ...DEFAULT_MERMAID_XY_CONFIG.xAxis,
              ...props.model.config.xAxis,
            },
            yAxis: {
              ...DEFAULT_MERMAID_XY_CONFIG.yAxis,
              ...props.model.config.yAxis,
            },
          };
          const desiredAppearance = {
            ...config,
            chartOrientation: currentConfig.chartOrientation,
          };
          const currentAppearance = {
            ...currentConfig,
            chartOrientation: currentConfig.chartOrientation,
          };
          if (
            JSON.stringify(desiredAppearance) !==
            JSON.stringify(currentAppearance)
          )
            commands.push({
              config: desiredAppearance,
              type: "appearance.config",
            });
          if (config.chartOrientation !== props.model.orientation)
            commands.push({
              orientation: config.chartOrientation ?? "vertical",
              type: "axis.orientation",
            });
          const applied =
            commands.length === 0 ||
            Boolean(dispatch(commands, undefined, true));
          if (applied && commands.length > 0 && selectedId) requestChartFocus();
          return applied;
        }}
        onPreview={(config) => {
          setAppearancePreview(config ?? undefined);
          props.onTitlePresentationPreview(
            config
              ? {
                  fontSize: config.titleFontSize,
                  padding: config.titlePadding,
                  visible: config.showTitle ?? true,
                }
              : null,
          );
        }}
        onOpenedChange={(opened) =>
          setActivePopover(opened ? "appearance" : undefined)
        }
        opened={activePopover === "appearance"}
        props={props}
      />
      <MermaidXyAccessibilityPopover
        onApply={(title, description) =>
          title === props.model.accessibilityTitle &&
          description === props.model.accessibilityDescription
            ? true
            : Boolean(
                dispatch(
                  { description, title, type: "diagram.accessibility" },
                  undefined,
                  true,
                ),
              )
        }
        onOpenedChange={(opened) =>
          setActivePopover(opened ? "accessibility" : undefined)
        }
        opened={activePopover === "accessibility"}
        props={props}
      />
    </Group>
  );
  const showCommentMarkers = commentsOpen || props.readonly;
  return (
    <>
      {showCommentMarkers && props.headerActionTarget
        ? createPortal(
            <MermaidXyCommentMarker
              anchor={{ kind: "diagram" }}
              onCommand={(command) => Boolean(dispatch(command))}
              props={props}
            />,
            props.headerActionTarget,
          )
        : null}
      <div
        data-testid="mermaid-xy-view"
        onClick={props.embedded ? undefined : stopEditorEvent}
        onKeyDown={props.embedded ? undefined : stopEditorEvent}
        onMouseDown={props.embedded ? undefined : stopEditorEvent}
        onPointerDown={props.embedded ? undefined : stopEditorEvent}
      >
        <ChartEditorSurface
          actionTarget={props.actionTarget}
          context={
            !props.readonly && dataOpen ? (
              <MermaidXyDataEditor
                onAddPlot={(kind, title, points) =>
                  Boolean(dispatch({ kind, points, title, type: "plot.add" }))
                }
                onAddPoint={(plotId, value) =>
                  dispatch({ plotId, type: "point.add", value })
                }
                onCategoryDelete={requestDelete}
                onCategoryRename={(categoryId, label) =>
                  dispatch({ categoryId, label, type: "category.rename" })
                }
                onCategoryReorder={reorderCategory}
                onDeletePoint={requestDelete}
                onPointReorder={reorderPoint}
                onPlotDelete={requestDelete}
                onPlotReorder={reorderPlot}
                onSelect={selectDataElement}
                onValue={(pointId, value) =>
                  dispatch(
                    { pointId, type: "point.value", value },
                    { coalesceKey: `xy:${pointId}:value` },
                  )
                }
                props={props}
                selectedId={selectedId}
              />
            ) : null
          }
          contextOpened={!props.readonly && dataOpen}
          contextTitle={props.labels.data}
          embedded={props.embedded}
          onCloseContext={() => {
            setDataOpen(false);
          }}
          pageViewport={props.pageViewport}
          selectedId={selectedId}
          selectionAction={{
            disabled:
              props.readonly ||
              !selectedId ||
              selectedId === "xy-axis-x" ||
              selectedId === "xy-axis-y",
            label: props.labels.delete,
            onSelect: () => selectedId && requestDelete(selectedId),
            register: props.onSelectionActionChange,
          }}
          toolbar={toolbar}
          workareaLabel={props.labels.chart}
        >
          <Stack gap="md">
            {notice ? (
              <Alert color="myoxusWarning" role="status" variant="light">
                {notice}
              </Alert>
            ) : null}
            {props.model.diagnostics
              .filter((diagnostic) => diagnostic.role === "diagram")
              .map((diagnostic) => (
                <Alert
                  color={
                    diagnostic.severity === "error"
                      ? "myoxusError"
                      : "myoxusWarning"
                  }
                  key={diagnostic.id}
                  role="status"
                  variant="light"
                >
                  {diagnostic.message}
                </Alert>
              ))}
            {deletePending ? (
              <Alert color="myoxusWarning" role="alert" variant="light">
                <Group justify="space-between">
                  <Stack gap="xs">
                    <MyoxusText>{deleteDescription()}</MyoxusText>
                    {deleteCategoryDetails().map((detail) => (
                      <MyoxusText key={detail.id} typographySlot="caption">
                        {detail.text}
                      </MyoxusText>
                    ))}
                  </Stack>
                  <Group>
                    <Button onClick={cancelDelete} variant="plain">
                      {props.labels.cancel}
                    </Button>
                    <Button onClick={confirmDelete}>
                      {props.labels.delete}
                    </Button>
                  </Group>
                </Group>
              </Alert>
            ) : null}
            <MermaidXyChartSurface
              appearancePreview={appearancePreview}
              editorDraft={editorDraft}
              editingId={editingId}
              emptyAction={
                props.readonly ? undefined : (
                  <MermaidXyEmptyActions
                    onAddCategory={(label, values) =>
                      Boolean(dispatch({ label, type: "category.add", values }))
                    }
                    onAddPlot={(kind, title, points) =>
                      Boolean(
                        dispatch({ kind, points, title, type: "plot.add" }),
                      )
                    }
                    props={props}
                  />
                )
              }
              focusRequestKey={focusRequestKey}
              onCancelPreview={() => setPreview(undefined)}
              onAxisTitleApply={(axis, title, form) => {
                const current =
                  axis === "x" ? props.model.xAxis : props.model.yAxis;
                const commands: MermaidXyCommand[] =
                  current.title === title &&
                  (!title || current.titleForm === form)
                    ? []
                    : [{ axis, form, title, type: "axis.title" }];
                const applied =
                  commands.length === 0 || Boolean(dispatch(commands));
                if (applied) setEditingId(undefined);
                if (applied) setEditorDraft(undefined);
                if (applied && commands.length > 0) requestChartFocus();
                return applied;
              }}
              onCategoryApply={(categoryId, label, reorderDirection) => {
                const category = props.model.xAxis.categories.find(
                  (candidate) => candidate.id === categoryId,
                );
                const commands: MermaidXyCommand[] = [];
                if (category && category.label !== label)
                  commands.push({ categoryId, label, type: "category.rename" });
                const reorder = reorderCategoryCommand(
                  categoryId,
                  reorderDirection,
                );
                if (reorder) commands.push(reorder);
                const applied =
                  commands.length === 0 || Boolean(dispatch(commands));
                if (applied) {
                  setEditingId(undefined);
                  setEditorDraft(undefined);
                  setStructuralPreview(undefined);
                  if (commands.length > 0) requestChartFocus();
                }
                return applied;
              }}
              onCommitPreview={(pointId, value) => {
                setPreview(undefined);
                if (dispatch({ pointId, type: "point.value", value }))
                  requestChartFocus();
              }}
              onEdit={beginEdit}
              onEditClose={() => {
                setEditingId(undefined);
                setEditorDraft(undefined);
                setStructuralPreview(undefined);
              }}
              onEditorDraftChange={setEditorDraft}
              onDelete={requestDelete}
              onCommentCommand={(command) => Boolean(dispatch(command))}
              onCommitReorder={commitReorder}
              onPointApply={applyPoint}
              onPlotApply={(plot, title, titleForm, kind, reorderDirection) => {
                const commands: MermaidXyCommand[] = [];
                if (title.trim() !== (plot.titleExplicit ? plot.title : ""))
                  commands.push({
                    plotId: plot.id,
                    title,
                    titleForm,
                    type: "plot.rename",
                  });
                else if (title.trim() && titleForm !== plot.titleForm)
                  commands.push({
                    plotId: plot.id,
                    titleForm,
                    type: "plot.title-form",
                  });
                if (kind !== plot.kind)
                  commands.push({ kind, plotId: plot.id, type: "plot.kind" });
                const reorder = reorderPlotCommand(plot.id, reorderDirection);
                if (reorder) commands.push(reorder);
                const applied =
                  commands.length === 0 || Boolean(dispatch(commands));
                if (applied) {
                  setEditingId(undefined);
                  setEditorDraft(undefined);
                  setStructuralPreview(undefined);
                  if (commands.length > 0) requestChartFocus();
                }
                return applied;
              }}
              onPreviewReorder={previewReorder}
              onPreview={(id, y) => setPreview({ id, y })}
              onSelect={selectChartElement}
              preview={preview}
              props={
                structuralPreview
                  ? { ...props, model: structuralPreview }
                  : props
              }
              selectedId={selectedId}
              showComments={showCommentMarkers}
            />
          </Stack>
        </ChartEditorSurface>
      </div>
    </>
  );
}

function MermaidXyRuntimeFallback({
  props,
  resetErrorBoundary,
}: FallbackProps & { readonly props: MermaidXyReactHostProps }) {
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

export function MermaidXyRuntime({
  props,
}: {
  readonly props: MermaidXyReactHostProps;
}) {
  return (
    <ErrorBoundary
      fallbackRender={(fallbackProps) => (
        <MermaidXyRuntimeFallback {...fallbackProps} props={props} />
      )}
      onError={(error) =>
        console.error("[mermaid:xy] visual renderer failed", error)
      }
      resetKeys={[props.model.sourceHash]}
    >
      <MermaidXyRuntimeBody props={props} />
    </ErrorBoundary>
  );
}

export function createMermaidXyRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidXyReactHostProps> {
  return {
    token: mermaidXyRendererToken,
    render: (props) => reactToLit(<MermaidXyRuntime props={props} />, true),
  };
}
