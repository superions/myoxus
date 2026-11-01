// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlusIcon } from "@myoxus/icons";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Button,
  DataRadarChart,
  Group,
  localizedChartNumber,
  localizedChartPreciseNumber,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import type {
  DataRadarAnnotationEditor,
  DataRadarSelection,
  DataRadarSelectionEditor,
} from "@myoxus/ui-facade";
import type {
  MermaidRadarCommand,
  MermaidRadarCommandSelection,
  MermaidRadarModel,
  MermaidRadarReactHostProps,
} from "@virgultum/block-mermaid";
import { DEFAULT_MERMAID_RADAR_CONFIG } from "@virgultum/block-mermaid";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { CHART_COLORS } from "../common";
import { MermaidRadarCommentsEditor } from "./comments";
import { uniqueRadarDiagnostics } from "./diagnostics";
import { MermaidRadarVertexPopover } from "./vertex-popover";

function facadeSelection(
  selection?: MermaidRadarCommandSelection,
): DataRadarSelection {
  if (selection?.kind === "axis") return { id: selection.id, kind: "axis" };
  if (selection?.kind === "curve") return { id: selection.id, kind: "curve" };
  if (selection?.kind === "vertex") return { id: selection.id, kind: "vertex" };
  return null;
}

function AxisEditor({
  axisId,
  onApply,
  onClose,
  onDelete,
  props,
}: {
  readonly axisId: string;
  readonly onApply: (commands: readonly MermaidRadarCommand[]) => boolean;
  readonly onClose: () => void;
  readonly onDelete: () => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  const axis = props.model.axes.find((candidate) => candidate.id === axisId)!;
  const [name, setName] = useState(axis.name);
  const [label, setLabel] = useState(axis.labelExplicit ? axis.label : "");
  const commands: MermaidRadarCommand[] = [
    ...(name.trim() !== axis.name
      ? [{ axisId, name: name.trim(), type: "axis.name" as const }]
      : []),
    ...(label.trim() !== (axis.labelExplicit ? axis.label : "")
      ? [{ axisId, label: label.trim(), type: "axis.label" as const }]
      : []),
  ];
  const diagnostics = uniqueRadarDiagnostics(
    props.model.diagnostics.filter(
      (diagnostic) =>
        diagnostic.objectId === axis.id ||
        diagnostic.objectId === axis.sourceRecordId,
    ),
  );
  return (
    <Stack gap="xs">
      {diagnostics.map((diagnostic) => (
        <Alert color="myoxusError" key={diagnostic.id} variant="light">
          {diagnostic.message ?? props.labels.invalid}
        </Alert>
      ))}
      <MyoxusTextInput
        aria-label={props.labels.label}
        autoFocus
        label={props.labels.label}
        onChange={setLabel}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter" && name.trim() && commands.length)
            onApply(commands);
        }}
        placeholder={axis.label}
        value={label}
      />
      <Accordion>
        <AccordionItem value="axis-more">
          <AccordionControl>{props.labels.more}</AccordionControl>
          <AccordionPanel>
            <MyoxusTextInput
              aria-label={props.labels.name}
              label={props.labels.name}
              onChange={setName}
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
                if (event.key === "Enter" && name.trim() && commands.length)
                  onApply(commands);
              }}
              value={name}
            />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      <Group justify="space-between">
        <Button color="myoxusError" onClick={onDelete} variant="plain">
          {props.labels.delete}
        </Button>
        <Group>
          <Button onClick={onClose} variant="plain">
            {props.labels.cancel}
          </Button>
          <Button
            disabled={!name.trim() || commands.length === 0}
            onClick={() => onApply(commands)}
          >
            {props.labels.apply}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

function CurveEditor({
  curveId,
  onApply,
  onClose,
  onConvert,
  onDelete,
  props,
}: {
  readonly curveId: string;
  readonly onApply: (commands: readonly MermaidRadarCommand[]) => boolean;
  readonly onClose: () => void;
  readonly onConvert: (form: "detailed" | "positional") => boolean;
  readonly onDelete: () => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  const curve = props.model.curves.find(
    (candidate) => candidate.id === curveId,
  )!;
  const [name, setName] = useState(curve.name);
  const [label, setLabel] = useState(curve.labelExplicit ? curve.label : "");
  const [form, setForm] = useState<"detailed" | "positional">(
    curve.sourceForm === "detailed" ? "detailed" : "positional",
  );
  const commands: MermaidRadarCommand[] = [
    ...(name.trim() !== curve.name
      ? [{ curveId, name: name.trim(), type: "curve.name" as const }]
      : []),
    ...(label.trim() !== (curve.labelExplicit ? curve.label : "")
      ? [{ curveId, label: label.trim(), type: "curve.label" as const }]
      : []),
  ];
  const diagnostics = uniqueRadarDiagnostics(
    props.model.diagnostics.filter(
      (diagnostic) =>
        diagnostic.objectId === curve.id ||
        diagnostic.objectId === curve.sourceRecordId ||
        curve.entries.some((entry) => entry.id === diagnostic.objectId),
    ),
  );
  const conversionValid =
    form === curve.sourceForm ||
    props.onPreviewCommand({
      curveId,
      form,
      type: "curve.form",
    }).changed;
  return (
    <Stack gap="xs">
      {diagnostics.map((diagnostic) => (
        <Alert color="myoxusError" key={diagnostic.id} variant="light">
          {diagnostic.message ?? props.labels.invalid}
        </Alert>
      ))}
      <MyoxusTextInput
        aria-label={props.labels.label}
        autoFocus
        label={props.labels.label}
        onChange={setLabel}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter" && name.trim() && commands.length)
            onApply(commands);
        }}
        placeholder={curve.label}
        value={label}
      />
      <Accordion>
        <AccordionItem value="curve-more">
          <AccordionControl>{props.labels.more}</AccordionControl>
          <AccordionPanel>
            <Stack gap="xs">
              <MyoxusTextInput
                aria-label={props.labels.name}
                label={props.labels.name}
                onChange={setName}
                onKeyDown={(event) => {
                  if (event.key === "Escape") onClose();
                  if (event.key === "Enter" && name.trim() && commands.length)
                    onApply(commands);
                }}
                value={name}
              />
              {curve.sourceForm === "mixed" ? null : (
                <MyoxusSegmentedControl
                  aria-label={props.labels.curve}
                  data={[
                    { label: props.labels.positional, value: "positional" },
                    { label: props.labels.detailed, value: "detailed" },
                  ]}
                  layout="fluid"
                  onChange={(value) =>
                    setForm(value as "detailed" | "positional")
                  }
                  value={form}
                />
              )}
              {curve.sourceForm !== "mixed" && form !== curve.sourceForm ? (
                <Stack gap={0}>
                  {form === "detailed" ? (
                    props.model.axes.map((axis) => {
                      const vertex = curve.vertices.find(
                        (candidate) => candidate.axisId === axis.id,
                      );
                      const separator = curve.entries[0]?.colon ? ":" : "";
                      return (
                        <MyoxusText key={axis.id} typographySlot="caption">
                          {props.labels.sourceValue(
                            `${axis.name}${separator} ${
                              vertex?.value === undefined
                                ? "–"
                                : String(vertex.value)
                            }`,
                          )}
                        </MyoxusText>
                      );
                    })
                  ) : (
                    <MyoxusText typographySlot="caption">
                      {props.labels.sourceValue(
                        props.model.axes
                          .map((axis) =>
                            String(
                              curve.vertices.find(
                                (candidate) => candidate.axisId === axis.id,
                              )?.value ?? "–",
                            ),
                          )
                          .join(", "),
                      )}
                    </MyoxusText>
                  )}
                  <Button
                    disabled={!conversionValid}
                    onClick={() => onConvert(form)}
                    variant="plain"
                  >
                    {props.labels.convertForm}
                  </Button>
                  {conversionValid ? null : (
                    <MyoxusText typographySlot="caption">
                      {props.labels.invalid}
                    </MyoxusText>
                  )}
                </Stack>
              ) : null}
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      <Group justify="space-between">
        <Button color="myoxusError" onClick={onDelete} variant="plain">
          {props.labels.delete}
        </Button>
        <Group>
          <Button onClick={onClose} variant="plain">
            {props.labels.cancel}
          </Button>
          <Button
            disabled={!name.trim() || commands.length === 0}
            onClick={() => onApply(commands)}
          >
            {props.labels.apply}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

export function MermaidRadarChartSurface({
  emptyAction,
  model,
  onCommand,
  onPreview,
  onPreviewCancel,
  onRequestDelete,
  onSelect,
  props,
  rangeModel,
  selection,
  showCommentMarkers,
}: {
  readonly emptyAction?: ReactNode;
  readonly model: MermaidRadarModel;
  readonly onCommand: (
    command: MermaidRadarCommand | readonly MermaidRadarCommand[],
  ) => boolean;
  readonly onPreview: (command: MermaidRadarCommand) => void;
  readonly onPreviewCancel: () => void;
  readonly onRequestDelete: (selection: MermaidRadarCommandSelection) => void;
  readonly onSelect: (selection: MermaidRadarCommandSelection) => void;
  readonly props: MermaidRadarReactHostProps;
  readonly rangeModel: MermaidRadarModel;
  readonly selection?: MermaidRadarCommandSelection;
  readonly showCommentMarkers: boolean;
}) {
  const [editing, setEditing] = useState<DataRadarSelection>(null);
  const [localFocusRequest, setLocalFocusRequest] = useState<{
    readonly key: number;
    readonly selection: Exclude<DataRadarSelection, null>;
  }>();
  const [commentDraft, setCommentDraft] = useState("");
  const editFrameRef = useRef<number | undefined>(undefined);
  const openEditor = (next: Exclude<DataRadarSelection, null>) => {
    onSelect(next);
    if (editFrameRef.current !== undefined)
      cancelAnimationFrame(editFrameRef.current);
    // Opening during the originating double-click lets the portal's outside
    // handler consume that same event and immediately close the editor.
    editFrameRef.current = requestAnimationFrame(() => {
      editFrameRef.current = undefined;
      setEditing(next);
    });
  };
  const closeEditor = () => {
    if (editing)
      setLocalFocusRequest((current) => ({
        key: (current?.key ?? 0) + 1,
        selection: editing,
      }));
    setEditing(null);
  };
  useEffect(() => {
    if (editFrameRef.current !== undefined)
      cancelAnimationFrame(editFrameRef.current);
    editFrameRef.current = undefined;
    setEditing(null);
  }, [props.model.sourceHash]);
  useEffect(() => {
    if (
      editing &&
      (!selection ||
        editing.kind !== selection.kind ||
        editing.id !== ("id" in selection ? selection.id : undefined))
    )
      setEditing(null);
  }, [editing, selection]);
  useEffect(
    () => () => {
      if (editFrameRef.current !== undefined)
        cancelAnimationFrame(editFrameRef.current);
    },
    [],
  );
  const selectionEditor: DataRadarSelectionEditor = (selected, controls) => {
    if (selected.kind === "axis")
      return (
        <AxisEditor
          axisId={selected.id}
          onApply={(commands) => {
            const applied = onCommand(commands);
            if (applied) controls.close();
            return applied;
          }}
          onClose={controls.close}
          onDelete={() => {
            controls.close();
            onRequestDelete(selected);
          }}
          props={{ ...props, model }}
        />
      );
    if (selected.kind === "curve")
      return (
        <CurveEditor
          curveId={selected.id}
          onApply={(commands) => {
            const applied = onCommand(commands);
            if (applied) controls.close();
            return applied;
          }}
          onClose={controls.close}
          onConvert={(form) => {
            const applied = onCommand({
              curveId: selected.id,
              form,
              type: "curve.form",
            });
            if (applied) controls.close();
            return applied;
          }}
          onDelete={() => {
            controls.close();
            onRequestDelete(selected);
          }}
          props={{ ...props, model }}
        />
      );
    const curve = model.curves.find((candidate) =>
      candidate.vertices.some((vertex) => vertex.id === selected.id),
    );
    const vertex = curve?.vertices.find(
      (candidate) => candidate.id === selected.id,
    );
    return curve && vertex ? (
      <MermaidRadarVertexPopover
        curve={curve}
        onApply={(commands) => {
          const applied = onCommand(commands);
          if (applied) controls.close();
          return applied;
        }}
        onClose={controls.close}
        onDelete={() => {
          controls.close();
          onRequestDelete(selected);
        }}
        props={{ ...props, model }}
        vertex={vertex}
      />
    ) : (
      <MyoxusText>{props.labels.invalid}</MyoxusText>
    );
  };
  const annotationEditor: DataRadarAnnotationEditor = (
    annotation,
    controls,
  ) => (
    <MermaidRadarCommentsEditor
      anchor={annotation}
      draft={commentDraft}
      onCommand={(command) => {
        const applied = onCommand(command);
        if (applied && command.type === "comment.add") setCommentDraft("");
        if (applied && command.type === "comment.delete") controls.close();
        return applied;
      }}
      onDraftChange={setCommentDraft}
      props={{ ...props, model }}
    />
  );
  const minimum = rangeModel.options.effective.minimum;
  const resolvedMaximum = rangeModel.options.effective.maximum;
  const maximum =
    resolvedMaximum !== null && resolvedMaximum > minimum
      ? resolvedMaximum
      : minimum + 1;
  const annotationCount = (kind: "axis" | "curve", id: string) => {
    if (!showCommentMarkers) return undefined;
    const count = model.comments.filter(
      (comment) => comment.anchor.kind === kind && comment.anchor.id === id,
    ).length;
    const owner =
      kind === "axis"
        ? model.axes.find((axis) => axis.id === id)
        : model.curves.find((curve) => curve.id === id);
    const record = owner
      ? model.sourceDocument.records.find(
          (candidate) => candidate.id === owner.sourceRecordId,
        )
      : undefined;
    const unambiguous =
      kind === "axis"
        ? record?.kind === "axis" && record.axes.length === 1
        : record?.kind === "curve" && record.curves.length === 1;
    return count > 0 || (!props.readonly && unambiguous) ? count : undefined;
  };
  const accessibleObjectLabel = (
    label: string,
    name: string,
    matchingLabels: number,
  ) =>
    label !== name || matchingLabels > 1
      ? `${label} · ${props.labels.name}: ${name}`
      : label;
  return (
    <DataRadarChart
      ariaDescription={model.accessibilityDescription || undefined}
      ariaLabel={model.accessibilityTitle || props.labels.visualEditor}
      annotationEditor={annotationEditor}
      annotationLabel={props.labels.commentCount}
      axes={model.axes.map((axis) => ({
        accessibleLabel: accessibleObjectLabel(
          axis.label,
          axis.name,
          model.axes.filter((candidate) => candidate.label === axis.label)
            .length,
        ),
        annotationCount: annotationCount("axis", axis.id),
        id: axis.id,
        label: axis.label,
      }))}
      curves={model.curves.map((curve, index) => ({
        accessibleLabel: accessibleObjectLabel(
          curve.label,
          curve.name,
          model.curves.filter((candidate) => candidate.label === curve.label)
            .length,
        ),
        annotationCount: annotationCount("curve", curve.id),
        color: CHART_COLORS[index % CHART_COLORS.length],
        id: curve.id,
        label: curve.label,
        vertices: curve.vertices.map((vertex) => ({
          ...vertex,
          step: vertex.entryId
            ? curve.entries.find((entry) => entry.id === vertex.entryId)
                ?.precision
            : undefined,
        })),
      }))}
      editing={editing}
      emptyAction={emptyAction}
      emptyLabel={
        model.axes.length === 0
          ? props.labels.emptyAxes
          : props.labels.emptyCurves
      }
      focusRequestKey={
        props.focusRequest?.key ??
        (localFocusRequest ? `local:${localFocusRequest.key}` : undefined)
      }
      focusSelection={
        props.focusRequest
          ? (facadeSelection(props.focusRequest.selection) ?? undefined)
          : localFocusRequest?.selection
      }
      graticule={model.options.effective.graticule}
      geometry={{ ...DEFAULT_MERMAID_RADAR_CONFIG, ...model.config }}
      interactive={!props.displayOnly}
      maximum={maximum}
      maximumIsExplicit={model.options.explicit.max !== undefined}
      minimum={minimum}
      onSelect={(next) => {
        setLocalFocusRequest(undefined);
        if (editing && (editing.kind !== next.kind || editing.id !== next.id))
          setEditing(null);
        onSelect(next);
      }}
      onEdit={openEditor}
      onEditClose={closeEditor}
      onEscapeGestureCancel={props.onConsumeEscape}
      onFocusRequestConsumed={props.onFocusRequestConsumed}
      onReorderCancel={onPreviewCancel}
      onReorderCommit={(kind, id, beforeId) => {
        onPreviewCancel();
        onCommand(
          kind === "axis"
            ? { axisId: id, beforeAxisId: beforeId, type: "axis.reorder" }
            : { beforeCurveId: beforeId, curveId: id, type: "curve.reorder" },
        );
      }}
      onReorderPreview={(kind, id, beforeId) =>
        onPreview(
          kind === "axis"
            ? { axisId: id, beforeAxisId: beforeId, type: "axis.reorder" }
            : { beforeCurveId: beforeId, curveId: id, type: "curve.reorder" },
        )
      }
      onVertexCancel={() => onPreviewCancel()}
      onVertexCommit={(vertexId, value) => {
        onPreviewCancel();
        const curve = model.curves.find((candidate) =>
          candidate.vertices.some((vertex) => vertex.id === vertexId),
        );
        const vertex = curve?.vertices.find(
          (candidate) => candidate.id === vertexId,
        );
        if (vertex?.entryId)
          onCommand({ entryId: vertex.entryId, type: "vertex.value", value });
      }}
      onVertexPreview={(vertexId, value) => {
        const curve = model.curves.find((candidate) =>
          candidate.vertices.some((vertex) => vertex.id === vertexId),
        );
        const vertex = curve?.vertices.find(
          (candidate) => candidate.id === vertexId,
        );
        if (vertex?.entryId)
          onPreview({ entryId: vertex.entryId, type: "vertex.value", value });
      }}
      readonly={props.readonly}
      revision={props.model.sourceHash}
      selected={props.displayOnly ? null : facadeSelection(selection)}
      selectionEditor={props.readonly ? undefined : selectionEditor}
      showLegend={model.options.effective.showLegend}
      ticks={model.options.effective.ticks}
      valueFormatter={localizedChartPreciseNumber}
      valueStepLabel={
        props.readonly
          ? undefined
          : (step, largeStep) =>
              props.labels.valueStep(
                localizedChartNumber(step),
                localizedChartNumber(largeStep),
              )
      }
      vertexStateLabel={(state) =>
        state === "duplicate"
          ? props.labels.duplicateReference
          : state === "missing"
            ? props.labels.missingReference
            : state === "clipped-high" || state === "clipped-low"
              ? props.labels.clippedVertices(1)
              : ""
      }
    />
  );
}

export function MermaidRadarEmptyActions({
  onAddAxis,
  onAddCurve,
  props,
}: {
  readonly onAddAxis: () => void;
  readonly onAddCurve: () => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  return (
    <Button
      onClick={props.model.axes.length === 0 ? onAddAxis : onAddCurve}
      prefix={<PlusIcon />}
    >
      {props.model.axes.length === 0
        ? props.labels.addAxis
        : props.labels.addCurve}
    </Button>
  );
}
