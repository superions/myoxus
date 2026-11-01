// SPDX-License-Identifier: AGPL-3.0-or-later

import { ArrowDownSmallIcon, ArrowUpSmallIcon, TrashIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  Group,
  IconButton,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidXyTextFitsForm,
  type MermaidXyCategory,
  type MermaidXyPlot,
  type MermaidXyPoint,
  type MermaidXyReactHostProps,
  type MermaidXyTextForm,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export type MermaidXyPointEditorDraft = {
  readonly id: string;
  readonly kind: "point";
  readonly label: string;
  readonly labelForm: MermaidXyTextForm;
  readonly reorderDirection: -1 | 0 | 1;
  readonly value: number | string;
};

export type MermaidXyPlotEditorDraft = {
  readonly id: string;
  readonly kind: "plot";
  readonly plotKind: "bar" | "line";
  readonly reorderDirection: -1 | 0 | 1;
  readonly title: string;
  readonly titleForm: MermaidXyTextForm;
};

export type MermaidXyCategoryEditorDraft = {
  readonly id: string;
  readonly kind: "category";
  readonly label: string;
  readonly reorderDirection: -1 | 0 | 1;
};

export type MermaidXyEditorDraft =
  | MermaidXyCategoryEditorDraft
  | MermaidXyPlotEditorDraft
  | MermaidXyPointEditorDraft;

function actionLabel(action: string, target: string) {
  return `${action}: ${target}`;
}

export function MermaidXyValuePopover({
  draft,
  onDraftChange,
  onDelete,
  onApply,
  onCancel,
  onPreviewReorder,
  plot,
  point,
  x,
  props,
}: {
  readonly draft: MermaidXyPointEditorDraft;
  readonly onApply: (
    value: number,
    label: string,
    labelForm: MermaidXyTextForm,
    reorderDirection: -1 | 0 | 1,
  ) => boolean;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly onDraftChange: (draft: MermaidXyPointEditorDraft) => void;
  readonly onPreviewReorder: (direction: -1 | 1 | null) => void;
  readonly plot: MermaidXyPlot;
  readonly point: MermaidXyPoint;
  readonly x: number | string;
  readonly props: MermaidXyReactHostProps;
}) {
  const { label, labelForm, reorderDirection, value } = draft;
  const parsed = typeof value === "number" ? value : Number(value);
  const invalid =
    !Number.isFinite(parsed) ||
    (Boolean(label.trim()) && !mermaidXyTextFitsForm(label.trim(), labelForm));
  const plotLabel = plot.titleExplicit
    ? plot.title
    : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`;
  const canMoveUp = point.order > 0;
  const canMoveDown = point.order < plot.points.length - 1;
  const pointLabel = `${plotLabel}: ${point.label || point.order + 1}`;
  return (
    <Stack
      aria-label={`${plotLabel} · ${point.label || point.order + 1}`}
      gap="xs"
      role="group"
    >
      <NumberInput
        aria-label={props.labels.value}
        autoFocus
        error={invalid ? props.labels.invalid : undefined}
        onChange={(value) => onDraftChange({ ...draft, value })}
        value={value}
      />
      <MyoxusText tone="secondary">
        {props.labels.x}: {x}
      </MyoxusText>
      <MyoxusTextInput
        aria-label={props.labels.label}
        error={
          label.trim() && !mermaidXyTextFitsForm(label.trim(), labelForm)
            ? props.labels.invalid
            : undefined
        }
        onChange={(label) => onDraftChange({ ...draft, label })}
        value={label}
      />
      <MyoxusSegmentedControl
        data={[
          { label: props.labels.plain, value: "plain" },
          { label: props.labels.quoted, value: "quoted" },
          { label: props.labels.markdown, value: "markdown" },
        ]}
        onChange={(value) =>
          onDraftChange({
            ...draft,
            labelForm: value as MermaidXyTextForm,
          })
        }
        value={labelForm}
      />
      {props.model.xAxis.effectiveKind === "linear" ? (
        <Alert color="myoxusInfo" variant="light">
          {props.labels.linearPointOrderImpact(plotLabel)}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <IconButton
          aria-label={actionLabel(props.labels.up, pointLabel)}
          disabled={!canMoveUp}
          icon={<ArrowUpSmallIcon />}
          onClick={() => {
            const next = reorderDirection === -1 ? 0 : -1;
            onDraftChange({ ...draft, reorderDirection: next });
            onPreviewReorder(next || null);
          }}
          tooltip={actionLabel(props.labels.up, pointLabel)}
          variant={reorderDirection === -1 ? "solid" : "plain"}
        />
        <IconButton
          aria-label={actionLabel(props.labels.down, pointLabel)}
          disabled={!canMoveDown}
          icon={<ArrowDownSmallIcon />}
          onClick={() => {
            const next = reorderDirection === 1 ? 0 : 1;
            onDraftChange({ ...draft, reorderDirection: next });
            onPreviewReorder(next || null);
          }}
          tooltip={actionLabel(props.labels.down, pointLabel)}
          variant={reorderDirection === 1 ? "solid" : "plain"}
        />
        <IconButton
          aria-label={actionLabel(props.labels.delete, pointLabel)}
          icon={<TrashIcon />}
          onClick={onDelete}
          tooltip={actionLabel(props.labels.delete, pointLabel)}
          variant="plain"
        />
        <Button
          onClick={() => {
            onPreviewReorder(null);
            onCancel();
          }}
          variant="plain"
        >
          {props.labels.cancel}
        </Button>
        <Button
          disabled={invalid}
          onClick={() => onApply(parsed, label, labelForm, reorderDirection)}
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidXyPlotPopover({
  draft,
  onDraftChange,
  onDelete,
  onApply,
  onCancel,
  onPreviewReorder,
  plot,
  props,
}: {
  readonly draft: MermaidXyPlotEditorDraft;
  readonly onApply: (
    title: string,
    titleForm: MermaidXyTextForm,
    kind: "bar" | "line",
    reorderDirection: -1 | 0 | 1,
  ) => boolean;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly onDraftChange: (draft: MermaidXyPlotEditorDraft) => void;
  readonly onPreviewReorder: (direction: -1 | 1 | null) => void;
  readonly plot: MermaidXyPlot;
  readonly props: MermaidXyReactHostProps;
}) {
  const { plotKind: kind, reorderDirection, title, titleForm } = draft;
  const plotLabel = plot.titleExplicit
    ? plot.title
    : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`;
  const invalid =
    Boolean(title.trim()) && !mermaidXyTextFitsForm(title.trim(), titleForm);
  const canMoveUp = plot.order > 0;
  const canMoveDown = plot.order < props.model.plots.length - 1;
  return (
    <Stack aria-label={plotLabel} gap="xs" role="group">
      <MyoxusTextInput
        aria-label={props.labels.plot}
        autoFocus
        error={invalid ? props.labels.invalid : undefined}
        onChange={(title) => onDraftChange({ ...draft, title })}
        value={title}
      />
      <MyoxusSegmentedControl
        data={[
          { label: props.labels.plain, value: "plain" },
          { label: props.labels.quoted, value: "quoted" },
          { label: props.labels.markdown, value: "markdown" },
        ]}
        onChange={(value) =>
          onDraftChange({
            ...draft,
            titleForm: value as MermaidXyTextForm,
          })
        }
        value={titleForm}
      />
      <MyoxusSegmentedControl
        aria-label={props.labels.plot}
        data={[
          { label: props.labels.bar, value: "bar" },
          { label: props.labels.line, value: "line" },
        ]}
        layout="fluid"
        onChange={(value) =>
          onDraftChange({
            ...draft,
            plotKind: value as "bar" | "line",
          })
        }
        value={kind}
      />
      {props.model.xAxis.sourceForm === "omitted" ||
      props.model.xAxis.sourceForm === "title-only" ? (
        <Alert color="myoxusInfo" variant="light">
          {props.labels.autoXSource(
            props.model.plots[0]
              ? props.model.plots[0].titleExplicit
                ? props.model.plots[0].title
                : `${props.model.plots[0].kind === "bar" ? props.labels.bar : props.labels.line} 1`
              : props.labels.plot,
            props.model.plots[0]?.points.length ?? 1,
          )}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <IconButton
          aria-label={actionLabel(props.labels.up, plotLabel)}
          disabled={!canMoveUp}
          icon={<ArrowUpSmallIcon />}
          onClick={() => {
            const next = reorderDirection === -1 ? 0 : -1;
            onDraftChange({ ...draft, reorderDirection: next });
            onPreviewReorder(next || null);
          }}
          tooltip={actionLabel(props.labels.up, plotLabel)}
          variant={reorderDirection === -1 ? "solid" : "plain"}
        />
        <IconButton
          aria-label={actionLabel(props.labels.down, plotLabel)}
          disabled={!canMoveDown}
          icon={<ArrowDownSmallIcon />}
          onClick={() => {
            const next = reorderDirection === 1 ? 0 : 1;
            onDraftChange({ ...draft, reorderDirection: next });
            onPreviewReorder(next || null);
          }}
          tooltip={actionLabel(props.labels.down, plotLabel)}
          variant={reorderDirection === 1 ? "solid" : "plain"}
        />
        <IconButton
          aria-label={actionLabel(props.labels.delete, plotLabel)}
          icon={<TrashIcon />}
          onClick={onDelete}
          tooltip={actionLabel(props.labels.delete, plotLabel)}
          variant="plain"
        />
        <Button
          onClick={() => {
            onPreviewReorder(null);
            onCancel();
          }}
          variant="plain"
        >
          {props.labels.cancel}
        </Button>
        <Button
          disabled={invalid}
          onClick={() => onApply(title, titleForm, kind, reorderDirection)}
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidXyCategoryPopover({
  category,
  draft,
  onApply,
  onCancel,
  onDelete,
  onDraftChange,
  onPreviewReorder,
  props,
}: {
  readonly category: MermaidXyCategory;
  readonly draft: MermaidXyCategoryEditorDraft;
  readonly onApply: (label: string, reorderDirection: -1 | 0 | 1) => boolean;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly onDraftChange: (draft: MermaidXyCategoryEditorDraft) => void;
  readonly onPreviewReorder: (direction: -1 | 1 | null) => void;
  readonly props: MermaidXyReactHostProps;
}) {
  const { label, reorderDirection } = draft;
  const invalid =
    !label.trim() || !mermaidXyTextFitsForm(label.trim(), category.textForm);
  const categoryReorderBlocked = props.model.plots.some(
    (plot) => plot.points.length !== props.model.xAxis.categories.length,
  );
  const canMoveUp = category.order > 0 && !categoryReorderBlocked;
  const canMoveDown =
    category.order < props.model.xAxis.categories.length - 1 &&
    !categoryReorderBlocked;
  return (
    <Stack aria-label={category.label} gap="xs" role="group">
      <MyoxusTextInput
        aria-label={props.labels.category}
        autoFocus
        error={invalid ? props.labels.invalid : undefined}
        onChange={(label) => onDraftChange({ ...draft, label })}
        value={label}
      />
      {categoryReorderBlocked ? (
        <Alert color="myoxusWarning" variant="light">
          {props.labels.commandFailure(
            "xy.category-mismatch-resolution-required",
          )}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <IconButton
          aria-label={actionLabel(props.labels.up, category.label)}
          disabled={!canMoveUp}
          icon={<ArrowUpSmallIcon />}
          onClick={() => {
            const next = reorderDirection === -1 ? 0 : -1;
            onDraftChange({ ...draft, reorderDirection: next });
            onPreviewReorder(next || null);
          }}
          tooltip={actionLabel(props.labels.up, category.label)}
          variant={reorderDirection === -1 ? "solid" : "plain"}
        />
        <IconButton
          aria-label={actionLabel(props.labels.down, category.label)}
          disabled={!canMoveDown}
          icon={<ArrowDownSmallIcon />}
          onClick={() => {
            const next = reorderDirection === 1 ? 0 : 1;
            onDraftChange({ ...draft, reorderDirection: next });
            onPreviewReorder(next || null);
          }}
          tooltip={actionLabel(props.labels.down, category.label)}
          variant={reorderDirection === 1 ? "solid" : "plain"}
        />
        <IconButton
          aria-label={actionLabel(props.labels.delete, category.label)}
          icon={<TrashIcon />}
          onClick={onDelete}
          tooltip={actionLabel(props.labels.delete, category.label)}
          variant="plain"
        />
        <Button
          onClick={() => {
            onPreviewReorder(null);
            onCancel();
          }}
          variant="plain"
        >
          {props.labels.cancel}
        </Button>
        <Button
          disabled={invalid}
          onClick={() => onApply(label.trim(), reorderDirection)}
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidXyAxisTitlePopover({
  axis,
  onApply,
  onCancel,
  props,
}: {
  readonly axis: "x" | "y";
  readonly onApply: (title: string, form: MermaidXyTextForm) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidXyReactHostProps;
}) {
  const model = axis === "x" ? props.model.xAxis : props.model.yAxis;
  const [title, setTitle] = useState(model.title);
  const [form, setForm] = useState<MermaidXyTextForm>(
    model.titleForm ?? "plain",
  );
  const invalid =
    Boolean(title.trim()) && !mermaidXyTextFitsForm(title.trim(), form);
  return (
    <Stack aria-label={axis === "x" ? props.labels.x : props.labels.y} gap="xs">
      <MyoxusTextInput
        aria-label={axis === "x" ? props.labels.x : props.labels.y}
        autoFocus
        error={invalid ? props.labels.invalid : undefined}
        onChange={setTitle}
        value={title}
      />
      <MyoxusSegmentedControl
        data={[
          { label: props.labels.plain, value: "plain" },
          { label: props.labels.quoted, value: "quoted" },
          { label: props.labels.markdown, value: "markdown" },
        ]}
        onChange={(value) => setForm(value as MermaidXyTextForm)}
        value={form}
      />
      <Group justify="flex-end">
        <Button onClick={onCancel} variant="plain">
          {props.labels.cancel}
        </Button>
        <Button disabled={invalid} onClick={() => onApply(title, form)}>
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}
