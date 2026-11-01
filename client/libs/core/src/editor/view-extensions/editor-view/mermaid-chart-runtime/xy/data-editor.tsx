// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  PlusIcon,
  TrashIcon,
} from "@myoxus/icons";
import {
  Alert,
  Button,
  Group,
  IconButton,
  localizedChartNumber,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import {
  mermaidXyTextFitsForm,
  type MermaidXyReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

export type MermaidXyDraftPoint = {
  readonly value: number;
};

function plotDisplayLabel(
  plot: MermaidXyReactHostProps["model"]["plots"][number],
  props: MermaidXyReactHostProps,
) {
  return plot.titleExplicit
    ? plot.title
    : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`;
}

function actionLabel(action: string, target: string) {
  return `${action}: ${target}`;
}

function finiteDraftValues(values: readonly (number | string)[]) {
  return (
    values.length > 0 &&
    values.every(
      (value) =>
        (typeof value === "number" || value.trim() !== "") &&
        Number.isFinite(Number(value)),
    )
  );
}

export function MermaidXyPlotDraft({
  onApply,
  onCancel,
  props,
}: {
  readonly onApply: (
    kind: "bar" | "line",
    title: string,
    points: readonly MermaidXyDraftPoint[],
  ) => void;
  readonly onCancel: () => void;
  readonly props: MermaidXyReactHostProps;
}) {
  const [kind, setKind] = useState<"bar" | "line">("bar");
  const [title, setTitle] = useState("");
  const bandCount = props.model.xAxis.categories.length;
  const [pointCount, setPointCount] = useState(
    props.model.xAxis.effectiveKind === "band" ? bandCount : 1,
  );
  const [values, setValues] = useState<(number | string)[]>(() =>
    Array.from({ length: pointCount }, () => ""),
  );
  useEffect(() => {
    setValues((current) =>
      Array.from({ length: pointCount }, (_, index) => current[index] ?? ""),
    );
  }, [pointCount]);
  const valid =
    finiteDraftValues(values) &&
    (!title.trim() || mermaidXyTextFitsForm(title.trim(), "quoted"));
  return (
    <Stack gap="xs">
      <MyoxusSegmentedControl
        aria-label={props.labels.plot}
        data={[
          { label: props.labels.bar, value: "bar" },
          { label: props.labels.line, value: "line" },
        ]}
        layout="fluid"
        onChange={(value) => setKind(value as "bar" | "line")}
        value={kind}
      />
      <MyoxusTextInput
        aria-label={props.labels.plot}
        autoFocus
        error={
          title.trim() && !mermaidXyTextFitsForm(title.trim(), "quoted")
            ? props.labels.invalid
            : undefined
        }
        onChange={setTitle}
        value={title}
      />
      {props.model.xAxis.effectiveKind === "linear" ? (
        <NumberInput
          aria-label={props.labels.addPoint}
          min={1}
          onChange={(value) => {
            const parsed = Number(value);
            if (Number.isInteger(parsed) && parsed > 0) setPointCount(parsed);
          }}
          value={pointCount}
        />
      ) : null}
      {values.map((value, index) => (
        <NumberInput
          aria-label={
            props.model.xAxis.categories[index]?.label ??
            `${props.labels.value} ${index + 1}`
          }
          key={
            props.model.xAxis.categories[index]?.id ?? `linear-point-${index}`
          }
          onChange={(next) =>
            setValues((current) =>
              current.map((candidate, valueIndex) =>
                valueIndex === index ? next : candidate,
              ),
            )
          }
          value={value}
        />
      ))}
      <Group justify="flex-end">
        <Button onClick={onCancel} variant="plain">
          {props.labels.cancel}
        </Button>
        <Button
          disabled={!valid}
          onClick={() =>
            onApply(
              kind,
              title.trim(),
              values.map((value) => ({ value: Number(value) })),
            )
          }
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidXyCategoryDraft({
  onApply,
  onCancel,
  props,
}: {
  readonly onApply: (
    label: string,
    values: readonly { plotId: string; value: number }[],
  ) => void;
  readonly onCancel: () => void;
  readonly props: MermaidXyReactHostProps;
}) {
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<(number | string)[]>(() =>
    props.model.plots.map(() => ""),
  );
  const categoryMappingAmbiguous = props.model.plots.some(
    (plot) => plot.points.length !== props.model.xAxis.categories.length,
  );
  const valid =
    !categoryMappingAmbiguous &&
    Boolean(label.trim()) &&
    mermaidXyTextFitsForm(label.trim(), "quoted") &&
    (props.model.plots.length === 0 || finiteDraftValues(values));
  return (
    <Stack gap="xs">
      <MyoxusTextInput
        aria-label={props.labels.category}
        autoFocus
        error={
          label.trim() && !mermaidXyTextFitsForm(label.trim(), "quoted")
            ? props.labels.invalid
            : undefined
        }
        onChange={setLabel}
        value={label}
      />
      {categoryMappingAmbiguous ? (
        <Alert color="myoxusWarning" variant="light">
          {props.labels.commandFailure(
            "xy.category-mismatch-resolution-required",
          )}
        </Alert>
      ) : null}
      {props.model.plots.map((plot, index) => (
        <NumberInput
          aria-label={`${plotDisplayLabel(plot, props)}: ${props.labels.value}`}
          key={plot.id}
          onChange={(next) =>
            setValues((current) =>
              current.map((candidate, valueIndex) =>
                valueIndex === index ? next : candidate,
              ),
            )
          }
          value={values[index]}
        />
      ))}
      <Group justify="flex-end">
        <Button onClick={onCancel} variant="plain">
          {props.labels.cancel}
        </Button>
        <Button
          disabled={!valid}
          onClick={() =>
            onApply(
              label.trim(),
              props.model.plots.map((plot, index) => ({
                plotId: plot.id,
                value: Number(values[index]),
              })),
            )
          }
        >
          {props.labels.apply}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidXyEmptyActions({
  onAddCategory,
  onAddPlot,
  props,
}: {
  readonly onAddCategory: (
    label: string,
    values: readonly { plotId: string; value: number }[],
  ) => boolean;
  readonly onAddPlot: (
    kind: "bar" | "line",
    title: string,
    points: readonly MermaidXyDraftPoint[],
  ) => boolean;
  readonly props: MermaidXyReactHostProps;
}) {
  const [plotOpened, setPlotOpened] = useState(false);
  const [categoryOpened, setCategoryOpened] = useState(false);
  return (
    <Group>
      <Popover onChange={setPlotOpened} opened={plotOpened}>
        <PopoverTarget>
          <Button onClick={() => setPlotOpened((value) => !value)}>
            {props.labels.addPlot}
          </Button>
        </PopoverTarget>
        <PopoverContent>
          <MermaidXyPlotDraft
            onApply={(kind, title, points) => {
              if (onAddPlot(kind, title, points)) setPlotOpened(false);
            }}
            onCancel={() => setPlotOpened(false)}
            props={props}
          />
        </PopoverContent>
      </Popover>
      {props.model.xAxis.effectiveKind === "band" ? (
        <Popover onChange={setCategoryOpened} opened={categoryOpened}>
          <PopoverTarget>
            <Button onClick={() => setCategoryOpened((value) => !value)}>
              {props.labels.addCategory}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            <MermaidXyCategoryDraft
              onApply={(label, values) => {
                if (onAddCategory(label, values)) setCategoryOpened(false);
              }}
              onCancel={() => setCategoryOpened(false)}
              props={props}
            />
          </PopoverContent>
        </Popover>
      ) : null}
    </Group>
  );
}

function CategoryLabel({
  category,
  invalidLabel,
  label,
  onRename,
  textForm,
}: {
  readonly category: string;
  readonly invalidLabel: string;
  readonly label: string;
  readonly onRename: (categoryId: string, label: string) => void;
  readonly textForm: MermaidXyReactHostProps["model"]["xAxis"]["categories"][number]["textForm"];
}) {
  const [draft, setDraft] = useState(label);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    setDraft(label);
    setSubmitted(false);
  }, [label]);
  const invalid =
    !draft.trim() || !mermaidXyTextFitsForm(draft.trim(), textForm);
  const apply = () => {
    if (!submitted && !invalid && draft.trim() !== label) {
      setSubmitted(true);
      onRename(category, draft.trim());
    } else if (invalid) setDraft(label);
  };
  return (
    <MyoxusTextInput
      aria-label={label}
      error={invalid ? invalidLabel : undefined}
      onBlur={apply}
      onChange={(value) => {
        setSubmitted(false);
        setDraft(value);
      }}
      onEnter={apply}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDraft(label);
      }}
      value={draft}
    />
  );
}

function ValueCell({
  invalidLabel,
  label,
  onApply,
  value,
}: {
  readonly invalidLabel: string;
  readonly label: string;
  readonly onApply: (value: number) => void;
  readonly value: number;
}) {
  const [draft, setDraft] = useState<number | string>(value);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    setDraft(value);
    setSubmitted(false);
  }, [value]);
  const parsed = Number(draft);
  const invalid =
    (typeof draft === "string" && draft.trim() === "") ||
    !Number.isFinite(parsed);
  const apply = () => {
    if (!submitted && !invalid && parsed !== value) {
      setSubmitted(true);
      onApply(parsed);
    }
  };
  return (
    <NumberInput
      aria-label={label}
      error={invalid ? invalidLabel : undefined}
      onBlur={apply}
      onChange={(next) => {
        setSubmitted(false);
        setDraft(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") apply();
        else if (event.key === "Escape") setDraft(value);
      }}
      value={draft}
    />
  );
}

export function MermaidXyDataEditor({
  onAddPlot,
  onAddPoint,
  onCategoryDelete,
  onCategoryRename,
  onCategoryReorder,
  onDeletePoint,
  onPointReorder,
  onPlotDelete,
  onPlotReorder,
  onSelect,
  onValue,
  props,
  selectedId,
}: {
  readonly onAddPlot: (
    kind: "bar" | "line",
    title: string,
    points: readonly MermaidXyDraftPoint[],
  ) => boolean;
  readonly onAddPoint: (plotId: string, value: number) => void;
  readonly onDeletePoint: (pointId: string) => void;
  readonly onCategoryDelete: (categoryId: string) => void;
  readonly onCategoryRename: (categoryId: string, label: string) => void;
  readonly onCategoryReorder: (categoryId: string, direction: -1 | 1) => void;
  readonly onPointReorder: (pointId: string, direction: -1 | 1) => void;
  readonly onPlotDelete: (plotId: string) => void;
  readonly onPlotReorder: (plotId: string, direction: -1 | 1) => void;
  readonly onSelect: (id: string) => void;
  readonly onValue: (pointId: string, value: number) => void;
  readonly props: MermaidXyReactHostProps;
  readonly selectedId?: string;
}) {
  const [plotDraftOpen, setPlotDraftOpen] = useState(false);
  const [addingPlotId, setAddingPlotId] = useState<string>();
  const [addValue, setAddValue] = useState<number | string>("");
  const addValueNumber = Number(addValue);
  const addValueValid =
    (typeof addValue === "number" || addValue.trim() !== "") &&
    Number.isFinite(addValueNumber);
  const closeAdd = () => {
    setAddingPlotId(undefined);
    setAddValue("");
  };
  const pointDraft = (plotId: string) =>
    addingPlotId === plotId ? (
      <Group wrap="nowrap">
        <NumberInput
          aria-label={props.labels.value}
          autoFocus
          onChange={setAddValue}
          value={addValue}
        />
        <Button onClick={closeAdd} variant="plain">
          {props.labels.cancel}
        </Button>
        <Button
          disabled={!addValueValid}
          onClick={() => {
            onAddPoint(plotId, addValueNumber);
            closeAdd();
          }}
        >
          {props.labels.apply}
        </Button>
      </Group>
    ) : (
      <Button
        onClick={() => {
          setAddingPlotId(plotId);
          setAddValue("");
        }}
        variant="plain"
      >
        {props.labels.addPoint}
      </Button>
    );
  const openPointDraft = (plotId: string) => {
    setAddingPlotId(plotId);
    setAddValue("");
  };
  return (
    <Stack gap="xs">
      <Group justify="flex-end">
        <Popover onChange={setPlotDraftOpen} opened={plotDraftOpen}>
          <PopoverTarget>
            <Button
              onClick={() => setPlotDraftOpen((opened) => !opened)}
              prefix={<PlusIcon />}
              variant="plain"
            >
              {props.labels.addPlot}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            <MermaidXyPlotDraft
              onApply={(kind, title, points) => {
                if (onAddPlot(kind, title, points)) setPlotDraftOpen(false);
              }}
              onCancel={() => setPlotDraftOpen(false)}
              props={props}
            />
          </PopoverContent>
        </Popover>
      </Group>
      {props.model.xAxis.effectiveKind === "band" ? (
        <Table aria-label={props.labels.category} striped withTableBorder>
          <TableHeader>
            <TableRow>
              <TableHead>{props.labels.category}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.model.xAxis.categories.map((category, categoryIndex) => (
              <TableRow
                data-selected={selectedId === category.id || undefined}
                key={category.id}
                onClickCapture={() => onSelect(category.id)}
              >
                <TableCell>
                  <CategoryLabel
                    category={category.id}
                    invalidLabel={props.labels.invalid}
                    label={category.label}
                    onRename={onCategoryRename}
                    textForm={category.textForm}
                  />
                </TableCell>
                <TableCell>
                  <Group wrap="nowrap">
                    <IconButton
                      aria-label={actionLabel(props.labels.up, category.label)}
                      disabled={
                        categoryIndex === 0 ||
                        props.model.plots.some(
                          (plot) =>
                            plot.points.length !==
                            props.model.xAxis.categories.length,
                        )
                      }
                      icon={<ArrowUpSmallIcon />}
                      onClick={() => onCategoryReorder(category.id, -1)}
                      tooltip={actionLabel(props.labels.up, category.label)}
                      variant="plain"
                    />
                    <IconButton
                      aria-label={actionLabel(
                        props.labels.down,
                        category.label,
                      )}
                      disabled={
                        categoryIndex ===
                          props.model.xAxis.categories.length - 1 ||
                        props.model.plots.some(
                          (plot) =>
                            plot.points.length !==
                            props.model.xAxis.categories.length,
                        )
                      }
                      icon={<ArrowDownSmallIcon />}
                      onClick={() => onCategoryReorder(category.id, 1)}
                      tooltip={actionLabel(props.labels.down, category.label)}
                      variant="plain"
                    />
                    <IconButton
                      aria-label={actionLabel(
                        props.labels.delete,
                        category.label,
                      )}
                      icon={<TrashIcon />}
                      onClick={() => onCategoryDelete(category.id)}
                      tooltip={actionLabel(props.labels.delete, category.label)}
                      variant="plain"
                    />
                  </Group>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {props.model.plots.map((plot, plotIndex) => (
        <Stack gap="xs" key={plot.id}>
          {props.model.diagnostics
            .filter((diagnostic) => diagnostic.recordId === plot.sourceRecordId)
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
          <Group justify="space-between">
            <MyoxusText>{plotDisplayLabel(plot, props)}</MyoxusText>
            <Group gap="xs" wrap="nowrap">
              {pointDraft(plot.id)}
              <IconButton
                aria-label={actionLabel(
                  props.labels.up,
                  plotDisplayLabel(plot, props),
                )}
                disabled={plotIndex === 0}
                icon={<ArrowUpSmallIcon />}
                onClick={() => onPlotReorder(plot.id, -1)}
                tooltip={actionLabel(
                  props.labels.up,
                  plotDisplayLabel(plot, props),
                )}
                variant="plain"
              />
              <IconButton
                aria-label={actionLabel(
                  props.labels.down,
                  plotDisplayLabel(plot, props),
                )}
                disabled={plotIndex === props.model.plots.length - 1}
                icon={<ArrowDownSmallIcon />}
                onClick={() => onPlotReorder(plot.id, 1)}
                tooltip={actionLabel(
                  props.labels.down,
                  plotDisplayLabel(plot, props),
                )}
                variant="plain"
              />
              <IconButton
                aria-label={actionLabel(
                  props.labels.delete,
                  plotDisplayLabel(plot, props),
                )}
                icon={<TrashIcon />}
                onClick={() => onPlotDelete(plot.id)}
                tooltip={actionLabel(
                  props.labels.delete,
                  plotDisplayLabel(plot, props),
                )}
                variant="plain"
              />
            </Group>
          </Group>
          <Table
            aria-label={plotDisplayLabel(plot, props)}
            striped
            withTableBorder
          >
            <TableHeader>
              <TableRow>
                <TableHead>{props.labels.category}</TableHead>
                <TableHead>{props.labels.value}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {plot.points.map((point, pointIndex) => {
                const category = props.model.xAxis.categories[point.order];
                const x =
                  props.model.xAxis.effectiveKind === "band"
                    ? (category?.label ??
                      props.labels.unmatchedPoint(point.order + 1))
                    : plot.points.length <= 1
                      ? props.model.xAxis.effectiveMinimum
                      : props.model.xAxis.effectiveMinimum +
                        (point.order / (plot.points.length - 1)) *
                          (props.model.xAxis.effectiveMaximum -
                            props.model.xAxis.effectiveMinimum);
                const pointLabel = `${plotDisplayLabel(plot, props)}: ${
                  point.label ||
                  (typeof x === "number" ? localizedChartNumber(x) : x)
                }`;
                return (
                  <TableRow
                    data-selected={selectedId === point.id || undefined}
                    key={point.id}
                    onClickCapture={() => onSelect(point.id)}
                  >
                    <TableCell>
                      {typeof x === "number" ? localizedChartNumber(x) : x}
                    </TableCell>
                    <TableCell>
                      <ValueCell
                        invalidLabel={props.labels.invalid}
                        label={`${plotDisplayLabel(plot, props)} ${point.order + 1}`}
                        onApply={(value) => onValue(point.id, value)}
                        value={point.value}
                      />
                    </TableCell>
                    <TableCell>
                      <Group wrap="nowrap">
                        <IconButton
                          aria-label={actionLabel(props.labels.up, pointLabel)}
                          disabled={pointIndex === 0}
                          icon={<ArrowUpSmallIcon />}
                          onClick={() => onPointReorder(point.id, -1)}
                          tooltip={actionLabel(props.labels.up, pointLabel)}
                          variant="plain"
                        />
                        <IconButton
                          aria-label={actionLabel(
                            props.labels.down,
                            pointLabel,
                          )}
                          disabled={pointIndex === plot.points.length - 1}
                          icon={<ArrowDownSmallIcon />}
                          onClick={() => onPointReorder(point.id, 1)}
                          tooltip={actionLabel(props.labels.down, pointLabel)}
                          variant="plain"
                        />
                        <IconButton
                          aria-label={actionLabel(
                            props.labels.delete,
                            pointLabel,
                          )}
                          icon={<TrashIcon />}
                          onClick={() => onDeletePoint(point.id)}
                          tooltip={actionLabel(props.labels.delete, pointLabel)}
                          variant="plain"
                        />
                      </Group>
                    </TableCell>
                  </TableRow>
                );
              })}
              {props.model.xAxis.effectiveKind === "band"
                ? props.model.xAxis.categories
                    .slice(plot.points.length)
                    .map((category, missingIndex) => (
                      <TableRow key={`${plot.id}-${category.id}-missing`}>
                        <TableCell>{category.label}</TableCell>
                        <TableCell>
                          <MyoxusText>{props.labels.missingPoint}</MyoxusText>
                        </TableCell>
                        <TableCell>
                          {missingIndex === 0 ? (
                            <Button onClick={() => openPointDraft(plot.id)}>
                              {props.labels.addPoint}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                : null}
            </TableBody>
          </Table>
        </Stack>
      ))}
    </Stack>
  );
}
