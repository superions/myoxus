// SPDX-License-Identifier: AGPL-3.0-or-later

import { DownloadIcon, MoreHorizontalIcon, SettingsIcon } from "@myoxus/icons";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Button,
  ColorInput,
  Group,
  IconButton,
  MyoxusTextInput,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  Scrollable,
  Stack,
  Switch,
  MyoxusText,
  Textarea,
} from "@myoxus/ui-facade";
import type {
  MermaidQuadrantConfig,
  MermaidQuadrantAppearanceCommand,
  MermaidQuadrantCommand,
  MermaidQuadrantClassDef,
  MermaidQuadrantReactHostProps,
  MermaidQuadrantAxisForm,
  MermaidQuadrantTextForm,
} from "@virgultum/block-mermaid";
import { DEFAULT_MERMAID_QUADRANT_CONFIG } from "@virgultum/block-mermaid";
import { useCallback, useEffect, useRef, useState } from "react";
import { MermaidQuadrantComments } from "./comments";

type QuadrantTextForms = [
  MermaidQuadrantTextForm,
  MermaidQuadrantTextForm,
  MermaidQuadrantTextForm,
  MermaidQuadrantTextForm,
];
type AxisTextForms = [MermaidQuadrantTextForm, MermaidQuadrantTextForm];

function validQuadrantConfig(config: MermaidQuadrantConfig) {
  const runtime = { ...DEFAULT_MERMAID_QUADRANT_CONFIG, ...config };
  const protectedInset =
    runtime.quadrantPadding +
    runtime.pointRadius +
    runtime.quadrantExternalBorderStrokeWidth;
  return (
    Object.entries(runtime).every(
      ([field, value]) =>
        field === "useMaxWidth" ||
        field === "xAxisPosition" ||
        field === "yAxisPosition" ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0),
    ) &&
    runtime.chartWidth > protectedInset * 2 &&
    runtime.chartHeight > protectedInset * 2
  );
}

function MermaidQuadrantClassRow({
  classDef,
  onCommand,
  onCommentCommand,
  props,
}: {
  readonly classDef: MermaidQuadrantClassDef;
  readonly onCommand: (command: MermaidQuadrantAppearanceCommand) => boolean;
  readonly onCommentCommand: (command: MermaidQuadrantCommand) => boolean;
  readonly props: MermaidQuadrantReactHostProps;
}) {
  const [name, setName] = useState(classDef.name);
  const [radius, setRadius] = useState<number | string>(
    classDef.style.radius ?? "",
  );
  const [color, setColor] = useState(classDef.style.color ?? "");
  const [strokeColor, setStrokeColor] = useState(
    classDef.style.strokeColor ?? "",
  );
  const [strokeWidth, setStrokeWidth] = useState(
    classDef.style.strokeWidth ?? "",
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [replacementClassId, setReplacementClassId] = useState<string>();
  const affected = props.model.points.filter(
    (point) => point.className === classDef.name,
  ).length;
  const validColor = (value: string) =>
    !value || /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
  const valid =
    /^\w+$/.test(name) &&
    (radius !== "" || color || strokeColor || strokeWidth) &&
    (radius === "" ||
      (typeof radius === "number" &&
        Number.isInteger(radius) &&
        radius >= 0)) &&
    validColor(color) &&
    validColor(strokeColor) &&
    (!strokeWidth || /^\d+px$/.test(strokeWidth));
  return (
    <Stack gap="xs">
      <MyoxusTextInput
        aria-label={props.labels.classes}
        onChange={setName}
        value={name}
      />
      <Group grow wrap="nowrap">
        <NumberInput
          aria-label={props.labels.pointRadius}
          min={0}
          onChange={setRadius}
          value={radius}
        />
        <ColorInput
          allowEmpty
          aria-label={props.labels.fillColor}
          onChange={setColor}
          value={color}
        />
      </Group>
      <Group grow wrap="nowrap">
        <ColorInput
          allowEmpty
          aria-label={props.labels.strokeColor}
          onChange={setStrokeColor}
          value={strokeColor}
        />
        <MyoxusTextInput
          aria-label={props.labels.strokeWidth}
          onChange={setStrokeWidth}
          value={strokeWidth}
        />
      </Group>
      <Group justify="flex-end" wrap="nowrap">
        <MermaidQuadrantComments
          anchor={{ id: classDef.id, kind: "classDef" }}
          onCommand={onCommentCommand}
          onDraftInvalidated={() => undefined}
          props={props}
        />
        <Button
          onClick={() => {
            if (affected > 0 && !confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            onCommand({
              classDefId: classDef.id,
              confirmAffectedPointIds: props.model.points
                .filter((point) => point.className === classDef.name)
                .map((point) => point.id),
              replacementClassId,
              type: "appearance.class-delete",
            });
          }}
          variant="plain"
        >
          {props.labels.delete}
          {affected > 0 ? ` (${affected})` : ""}
        </Button>
        <Button
          disabled={!valid}
          onClick={() =>
            onCommand({
              classDefId: classDef.id,
              name,
              style: {
                color: color || undefined,
                radius: typeof radius === "number" ? radius : undefined,
                strokeColor: strokeColor || undefined,
                strokeWidth: strokeWidth || undefined,
              },
              type: "appearance.class-update",
            })
          }
        >
          {props.labels.apply}
        </Button>
      </Group>
      {confirmDelete && affected > 0 ? (
        <Select
          aria-label={props.labels.classes}
          clearable
          data={props.model.classes
            .filter((candidate) => candidate.id !== classDef.id)
            .map((candidate) => ({
              label: candidate.name,
              value: candidate.id,
            }))}
          onChange={(value) => setReplacementClassId(value ?? undefined)}
          onClear={() => setReplacementClassId(undefined)}
          value={replacementClassId ?? null}
        />
      ) : null}
    </Stack>
  );
}

export function MermaidQuadrantSettingsPopover({
  onApply,
  onClassCommand,
  onCommand,
  onPreview,
  onStale,
  props,
}: {
  readonly onApply: (input: {
    config: MermaidQuadrantConfig;
    quadrantForms: Readonly<QuadrantTextForms>;
    quadrantLabels: readonly [string, string, string, string];
    xAxis: readonly [string, string];
    xAxisForm: MermaidQuadrantAxisForm;
    xAxisTextForms: Readonly<AxisTextForms>;
    yAxis: readonly [string, string];
    yAxisForm: MermaidQuadrantAxisForm;
    yAxisTextForms: Readonly<AxisTextForms>;
  }) => boolean;
  readonly onClassCommand: (
    command: MermaidQuadrantAppearanceCommand,
  ) => boolean;
  readonly onCommand: (command: MermaidQuadrantCommand) => boolean;
  readonly onPreview: (config: MermaidQuadrantConfig | null) => void;
  readonly onStale: () => void;
  readonly props: MermaidQuadrantReactHostProps;
}) {
  const [opened, setOpened] = useState(false);
  const [revision, setRevision] = useState(props.model.sourceHash);
  const [xAxis, setXAxis] = useState<[string, string]>([
    props.model.xAxisStart,
    props.model.xAxisEnd,
  ]);
  const [yAxis, setYAxis] = useState<[string, string]>([
    props.model.yAxisStart,
    props.model.yAxisEnd,
  ]);
  const [xAxisForm, setXAxisForm] = useState(props.model.axes.x.form);
  const [yAxisForm, setYAxisForm] = useState(props.model.axes.y.form);
  const [xAxisTextForms, setXAxisTextForms] = useState<AxisTextForms>([
    props.model.axes.x.startForm,
    props.model.axes.x.endForm,
  ]);
  const [yAxisTextForms, setYAxisTextForms] = useState<AxisTextForms>([
    props.model.axes.y.startForm,
    props.model.axes.y.endForm,
  ]);
  const [quadrants, setQuadrants] = useState<[string, string, string, string]>([
    ...props.model.quadrantLabels,
  ]);
  const [quadrantForms, setQuadrantForms] = useState<QuadrantTextForms>(
    props.model.quadrantTexts.map((text) => text.form) as QuadrantTextForms,
  );
  const [config, setConfig] = useState<MermaidQuadrantConfig>({
    ...props.model.config,
  });
  const [newClassName, setNewClassName] = useState("");
  const [newClassRadius, setNewClassRadius] = useState<number | string>(
    props.model.config.pointRadius ??
      DEFAULT_MERMAID_QUADRANT_CONFIG.pointRadius,
  );
  const [newClassColor, setNewClassColor] = useState("");
  const [newClassStrokeColor, setNewClassStrokeColor] = useState("");
  const [newClassStrokeWidth, setNewClassStrokeWidth] = useState("");
  const ownCommitPendingRef = useRef(false);
  const lastValidConfigPreviewRef = useRef<MermaidQuadrantConfig | null>(null);
  const reset = useCallback(() => {
    setXAxis([props.model.xAxisStart, props.model.xAxisEnd]);
    setYAxis([props.model.yAxisStart, props.model.yAxisEnd]);
    setXAxisForm(props.model.axes.x.form);
    setYAxisForm(props.model.axes.y.form);
    setXAxisTextForms([
      props.model.axes.x.startForm,
      props.model.axes.x.endForm,
    ]);
    setYAxisTextForms([
      props.model.axes.y.startForm,
      props.model.axes.y.endForm,
    ]);
    setQuadrants([...props.model.quadrantLabels]);
    setQuadrantForms(
      props.model.quadrantTexts.map((text) => text.form) as QuadrantTextForms,
    );
    setConfig({ ...props.model.config });
    setRevision(props.model.sourceHash);
    lastValidConfigPreviewRef.current = null;
    onPreview(null);
  }, [onPreview, props.model]);
  const updateConfig = (next: MermaidQuadrantConfig) => {
    setConfig(next);
    if (validQuadrantConfig(next)) {
      lastValidConfigPreviewRef.current = next;
      onPreview(next);
    } else onPreview(lastValidConfigPreviewRef.current);
  };
  useEffect(() => {
    if (revision === props.model.sourceHash) return;
    if (ownCommitPendingRef.current) {
      ownCommitPendingRef.current = false;
      reset();
      return;
    }
    if (opened) {
      setOpened(false);
      onStale();
    }
    reset();
  }, [opened, onStale, props.model.sourceHash, reset, revision]);
  const commitClassCommand = (command: MermaidQuadrantAppearanceCommand) => {
    const changed = onClassCommand(command);
    if (changed) ownCommitPendingRef.current = true;
    return changed;
  };
  const commitCommand = (command: MermaidQuadrantCommand) => {
    const changed = onCommand(command);
    if (changed) ownCommitPendingRef.current = true;
    return changed;
  };
  const runtimeConfig = {
    ...DEFAULT_MERMAID_QUADRANT_CONFIG,
    ...config,
  };
  const configNumber = (field: keyof MermaidQuadrantConfig, label: string) => (
    <NumberInput
      aria-label={label}
      min={0}
      onChange={(value) =>
        updateConfig({
          ...config,
          [field]: typeof value === "number" ? value : undefined,
        })
      }
      value={runtimeConfig[field] as number | undefined}
    />
  );
  const configValid = validQuadrantConfig(config);
  const diagnosticAlerts = (...codes: string[]) =>
    props.model.diagnostics
      .filter((diagnostic) => codes.includes(diagnostic.code))
      .map((diagnostic) => (
        <Alert color="myoxusWarning" key={diagnostic.id} variant="light">
          {diagnostic.message}
        </Alert>
      ));
  const newClassValid =
    /^\w+$/.test(newClassName) &&
    typeof newClassRadius === "number" &&
    Number.isInteger(newClassRadius) &&
    newClassRadius >= 0 &&
    (!newClassColor || /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(newClassColor)) &&
    (!newClassStrokeColor ||
      /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(newClassStrokeColor)) &&
    (!newClassStrokeWidth || /^\d+px$/.test(newClassStrokeWidth));
  return (
    <Popover
      opened={opened}
      onChange={(next) => {
        if (!next) reset();
        setOpened(next);
      }}
      position="bottom-end"
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <IconButton
          aria-label={props.labels.appearance}
          icon={<SettingsIcon />}
          onClick={() => setOpened((current) => !current)}
          tooltip={props.labels.appearance}
        />
      </PopoverTarget>
      <PopoverContent
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Scrollable.Viewport
          aria-label={props.labels.appearance}
          autosize
          maxHeight="popover"
        >
          <Stack gap="xs">
            <Accordion defaultValue="text">
              <AccordionItem value="text">
                <AccordionControl>{props.labels.label}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {diagnosticAlerts("invalid-axis")}
                    {(
                      [
                        [
                          props.labels.xAxisStart,
                          xAxis[0],
                          (value: string) => setXAxis([value, xAxis[1]]),
                          xAxisTextForms[0],
                          (form: MermaidQuadrantTextForm) =>
                            setXAxisTextForms([form, xAxisTextForms[1]]),
                        ],
                        [
                          props.labels.xAxisEnd,
                          xAxis[1],
                          (value: string) => setXAxis([xAxis[0], value]),
                          xAxisTextForms[1],
                          (form: MermaidQuadrantTextForm) =>
                            setXAxisTextForms([xAxisTextForms[0], form]),
                        ],
                        [
                          props.labels.yAxisStart,
                          yAxis[0],
                          (value: string) => setYAxis([value, yAxis[1]]),
                          yAxisTextForms[0],
                          (form: MermaidQuadrantTextForm) =>
                            setYAxisTextForms([form, yAxisTextForms[1]]),
                        ],
                        [
                          props.labels.yAxisEnd,
                          yAxis[1],
                          (value: string) => setYAxis([yAxis[0], value]),
                          yAxisTextForms[1],
                          (form: MermaidQuadrantTextForm) =>
                            setYAxisTextForms([yAxisTextForms[0], form]),
                        ],
                      ] as const
                    ).map(([label, value, change, form, changeForm]) => (
                      <Group grow key={label} wrap="nowrap">
                        <MyoxusTextInput
                          aria-label={label}
                          onChange={change}
                          value={value}
                        />
                        <Select
                          aria-label={`${label} · ${props.labels.labelForm}`}
                          data={[
                            { label: props.labels.plain, value: "plain" },
                            { label: props.labels.quoted, value: "quoted" },
                            { label: props.labels.markdown, value: "markdown" },
                          ]}
                          onChange={(next) =>
                            changeForm(next as MermaidQuadrantTextForm)
                          }
                          value={form}
                        />
                      </Group>
                    ))}
                    <Group grow wrap="nowrap">
                      {(
                        [
                          [props.labels.xAxisStart, xAxisForm, setXAxisForm],
                          [props.labels.yAxisStart, yAxisForm, setYAxisForm],
                        ] as const
                      ).map(([label, value, change]) => (
                        <Select
                          aria-label={label}
                          data={[
                            { label: "A", value: "single" },
                            { label: "A -->", value: "left-open" },
                            { label: "A --> B", value: "both" },
                          ]}
                          key={label}
                          onChange={(next) =>
                            change(next as MermaidQuadrantAxisForm)
                          }
                          value={value}
                        />
                      ))}
                    </Group>
                    {quadrants.map((value, index) => (
                      <Group grow key={index} wrap="nowrap">
                        <MyoxusTextInput
                          aria-label={`${props.labels.quadrantLabel} ${index + 1}`}
                          onChange={(next) =>
                            setQuadrants((current) => {
                              const values = [...current] as typeof current;
                              values[index] = next;
                              return values;
                            })
                          }
                          value={value}
                        />
                        <Select
                          aria-label={`${props.labels.labelForm} ${index + 1}`}
                          data={[
                            { label: props.labels.plain, value: "plain" },
                            { label: props.labels.quoted, value: "quoted" },
                            { label: props.labels.markdown, value: "markdown" },
                          ]}
                          onChange={(next) =>
                            setQuadrantForms((current) => {
                              const values = [...current] as typeof current;
                              values[index] = next as MermaidQuadrantTextForm;
                              return values;
                            })
                          }
                          value={quadrantForms[index]}
                        />
                      </Group>
                    ))}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="size">
                <AccordionControl>{`${props.labels.width} · ${props.labels.height}`}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {diagnosticAlerts("invalid-config")}
                    <Switch
                      checked={runtimeConfig.useMaxWidth}
                      onChange={(useMaxWidth) =>
                        updateConfig({ ...config, useMaxWidth })
                      }
                    >
                      {props.labels.useMaxWidth}
                    </Switch>
                    {configNumber(
                      "chartWidth",
                      `${props.labels.chart} · ${props.labels.width}`,
                    )}
                    {configNumber(
                      "chartHeight",
                      `${props.labels.chart} · ${props.labels.height}`,
                    )}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="spacing">
                <AccordionControl>{props.labels.padding}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {configNumber(
                      "quadrantPadding",
                      `${props.labels.quadrantLabel} · ${props.labels.padding}`,
                    )}
                    {configNumber(
                      "xAxisLabelPadding",
                      `${props.labels.x} · ${props.labels.padding}`,
                    )}
                    {configNumber(
                      "yAxisLabelPadding",
                      `${props.labels.y} · ${props.labels.padding}`,
                    )}
                    {configNumber(
                      "quadrantTextTopPadding",
                      `${props.labels.quadrantLabel} · ${props.labels.top} · ${props.labels.padding}`,
                    )}
                    {configNumber(
                      "pointTextPadding",
                      `${props.labels.coordinates} · ${props.labels.padding}`,
                    )}
                    {configNumber(
                      "titlePadding",
                      `${props.labels.accessibilityTitle} · ${props.labels.padding}`,
                    )}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="text-points">
                <AccordionControl>{`${props.labels.fontSize} · ${props.labels.pointRadius}`}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {configNumber(
                      "titleFontSize",
                      `${props.labels.accessibilityTitle} · ${props.labels.fontSize}`,
                    )}
                    {configNumber(
                      "xAxisLabelFontSize",
                      `${props.labels.x} · ${props.labels.fontSize}`,
                    )}
                    {configNumber(
                      "yAxisLabelFontSize",
                      `${props.labels.y} · ${props.labels.fontSize}`,
                    )}
                    {configNumber(
                      "quadrantLabelFontSize",
                      `${props.labels.quadrantLabel} · ${props.labels.fontSize}`,
                    )}
                    {configNumber(
                      "pointLabelFontSize",
                      `${props.labels.coordinates} · ${props.labels.fontSize}`,
                    )}
                    {configNumber("pointRadius", props.labels.pointRadius)}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="axes-borders">
                <AccordionControl>{`${props.labels.position} · ${props.labels.internalBorder}`}</AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    <Group grow wrap="nowrap">
                      <Select
                        aria-label={`${props.labels.x} · ${props.labels.position}`}
                        data={[
                          { label: props.labels.top, value: "top" },
                          { label: props.labels.bottom, value: "bottom" },
                        ]}
                        onChange={(xAxisPosition) =>
                          updateConfig({
                            ...config,
                            xAxisPosition: xAxisPosition as "bottom" | "top",
                          })
                        }
                        value={runtimeConfig.xAxisPosition}
                      />
                      <Select
                        aria-label={`${props.labels.y} · ${props.labels.position}`}
                        data={[
                          { label: props.labels.left, value: "left" },
                          { label: props.labels.right, value: "right" },
                        ]}
                        onChange={(yAxisPosition) =>
                          updateConfig({
                            ...config,
                            yAxisPosition: yAxisPosition as "left" | "right",
                          })
                        }
                        value={runtimeConfig.yAxisPosition}
                      />
                    </Group>
                    {configNumber(
                      "quadrantInternalBorderStrokeWidth",
                      props.labels.internalBorder,
                    )}
                    {configNumber(
                      "quadrantExternalBorderStrokeWidth",
                      props.labels.externalBorder,
                    )}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
              <AccordionItem value="classes">
                <AccordionControl>
                  {props.labels.classDefinitions}
                </AccordionControl>
                <AccordionPanel>
                  <Stack gap="xs">
                    {diagnosticAlerts("invalid-class", "invalid-style")}
                    {props.model.classes.map((classDef) => (
                      <MermaidQuadrantClassRow
                        classDef={classDef}
                        key={classDef.id}
                        onCommand={commitClassCommand}
                        onCommentCommand={commitCommand}
                        props={props}
                      />
                    ))}
                    <Group align="flex-end" wrap="nowrap">
                      <MyoxusTextInput
                        aria-label={props.labels.classes}
                        onChange={setNewClassName}
                        value={newClassName}
                      />
                      <Button
                        disabled={!newClassValid}
                        onClick={() => {
                          if (
                            commitClassCommand({
                              name: newClassName,
                              style: {
                                color: newClassColor || undefined,
                                radius:
                                  typeof newClassRadius === "number"
                                    ? newClassRadius
                                    : undefined,
                                strokeColor: newClassStrokeColor || undefined,
                                strokeWidth: newClassStrokeWidth || undefined,
                              },
                              type: "appearance.class-add",
                            })
                          )
                            setNewClassName("");
                        }}
                      >
                        {props.labels.add}
                      </Button>
                    </Group>
                    <Group grow wrap="nowrap">
                      <NumberInput
                        aria-label={props.labels.pointRadius}
                        min={0}
                        onChange={setNewClassRadius}
                        value={newClassRadius}
                      />
                      <ColorInput
                        allowEmpty
                        aria-label={props.labels.fillColor}
                        onChange={setNewClassColor}
                        value={newClassColor}
                      />
                    </Group>
                    <Group grow wrap="nowrap">
                      <ColorInput
                        allowEmpty
                        aria-label={props.labels.strokeColor}
                        onChange={setNewClassStrokeColor}
                        value={newClassStrokeColor}
                      />
                      <MyoxusTextInput
                        aria-label={props.labels.strokeWidth}
                        onChange={setNewClassStrokeWidth}
                        value={newClassStrokeWidth}
                      />
                    </Group>
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
            {!configValid ? (
              <MyoxusText role="alert">{props.labels.invalid}</MyoxusText>
            ) : null}
            <Group justify="flex-end" wrap="nowrap">
              <Button
                onClick={() => {
                  const runtime = { ...DEFAULT_MERMAID_QUADRANT_CONFIG };
                  updateConfig(runtime);
                }}
                variant="plain"
              >
                {props.labels.reset}
              </Button>
              <Button
                onClick={() => {
                  reset();
                  setOpened(false);
                }}
                variant="plain"
              >
                {props.labels.cancel}
              </Button>
              <Button
                disabled={!configValid}
                onClick={() => {
                  if (
                    onApply({
                      config,
                      quadrantForms,
                      quadrantLabels: quadrants,
                      xAxis,
                      xAxisForm,
                      xAxisTextForms,
                      yAxis,
                      yAxisForm,
                      yAxisTextForms,
                    })
                  ) {
                    setOpened(false);
                  }
                }}
              >
                {props.labels.apply}
              </Button>
            </Group>
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}

export function MermaidQuadrantMorePopover({
  onApply,
  props,
}: {
  readonly onApply: (title: string, description: string) => boolean;
  readonly props: MermaidQuadrantReactHostProps;
}) {
  const [opened, setOpened] = useState(false);
  const [title, setTitle] = useState(props.model.accessibilityTitle);
  const [description, setDescription] = useState(
    props.model.accessibilityDescription,
  );
  const close = () => {
    setOpened(false);
    setTitle(props.model.accessibilityTitle);
    setDescription(props.model.accessibilityDescription);
  };
  return (
    <Popover
      opened={opened}
      onChange={(next) => (next ? setOpened(true) : close())}
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <IconButton
          aria-label={props.labels.more}
          icon={<MoreHorizontalIcon />}
          onClick={() => (opened ? close() : setOpened(true))}
          tooltip={props.labels.more}
        />
      </PopoverTarget>
      <PopoverContent
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Stack gap="xs">
          <MyoxusTextInput
            aria-label={props.labels.accessibilityTitle}
            onChange={setTitle}
            value={title}
          />
          <Textarea
            aria-label={props.labels.accessibilityDescription}
            autosize
            onChange={setDescription}
            value={description}
          />
          <Button
            prefix={<DownloadIcon />}
            onClick={props.onExportMmd}
            variant="plain"
          >
            {props.labels.exportMmd}
          </Button>
          <Group justify="flex-end" wrap="nowrap">
            <Button onClick={close} variant="plain">
              {props.labels.cancel}
            </Button>
            <Button
              onClick={() => {
                if (onApply(title, description)) close();
              }}
            >
              {props.labels.apply}
            </Button>
          </Group>
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
