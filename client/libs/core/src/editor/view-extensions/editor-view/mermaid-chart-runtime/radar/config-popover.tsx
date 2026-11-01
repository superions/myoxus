// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusSwitch,
  MyoxusText,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  DEFAULT_MERMAID_RADAR_CONFIG,
  type MermaidRadarConfig,
  type MermaidRadarModel,
  type MermaidRadarReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

import { radarConfigSourceKey, radarConfigSourceValue } from "./source-values";

type CompleteRadarConfig = Required<MermaidRadarConfig>;

const NUMERIC_FIELDS = [
  "width",
  "height",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "axisScaleFactor",
  "axisLabelFactor",
  "curveTension",
] as const;

type RadarConfigDraft = Omit<
  CompleteRadarConfig,
  (typeof NUMERIC_FIELDS)[number]
> &
  Record<(typeof NUMERIC_FIELDS)[number], number | string>;

function commandConfig(config: RadarConfigDraft): CompleteRadarConfig {
  return {
    ...config,
    ...Object.fromEntries(
      NUMERIC_FIELDS.map((field) => [
        field,
        typeof config[field] === "number" ? config[field] : Number.NaN,
      ]),
    ),
  } as CompleteRadarConfig;
}

function configKey(config: RadarConfigDraft) {
  return JSON.stringify(config);
}

export function MermaidRadarConfigEditor({
  onApply,
  onCancel,
  onPreview,
  props,
}: {
  readonly onApply: (config: CompleteRadarConfig) => boolean;
  readonly onCancel: () => void;
  readonly onPreview: (model: MermaidRadarModel | null) => void;
  readonly props: MermaidRadarReactHostProps;
}) {
  const effective = { ...DEFAULT_MERMAID_RADAR_CONFIG, ...props.model.config };
  const [config, setConfig] = useState<RadarConfigDraft>(effective);
  const [sourceConflict, setSourceConflict] = useState(false);
  const baseRef = useRef({
    draftKey: configKey(effective),
    ownerKey: radarConfigSourceKey(props.model),
    sourceHash: props.model.sourceHash,
  });
  const draftRef = useRef(config);
  draftRef.current = config;
  useEffect(() => {
    if (baseRef.current.sourceHash === props.model.sourceHash) return;
    const next = { ...DEFAULT_MERMAID_RADAR_CONFIG, ...props.model.config };
    const nextBase = {
      draftKey: configKey(next),
      ownerKey: radarConfigSourceKey(props.model),
      sourceHash: props.model.sourceHash,
    };
    const ownerChanged = baseRef.current.ownerKey !== nextBase.ownerKey;
    const draftChanged =
      configKey(draftRef.current) !== baseRef.current.draftKey;
    if (ownerChanged && draftChanged) {
      setSourceConflict(true);
      return;
    }
    baseRef.current = nextBase;
    setSourceConflict(false);
    if (ownerChanged) setConfig(next);
  }, [props.model.config, props.model.sourceHash]);
  const desired = useMemo(() => commandConfig(config), [config]);
  const preview = useMemo(
    () =>
      props.onPreviewCommand({
        config: desired,
        type: "config.apply",
      }),
    [desired, props.onPreviewCommand],
  );
  const previewModel = preview.changed ? preview.model : undefined;
  useEffect(() => {
    onPreview(previewModel ?? null);
    return () => onPreview(null);
  }, [onPreview, previewModel]);
  const setNumber = (
    field: (typeof NUMERIC_FIELDS)[number],
    value: number | string,
  ) => {
    setConfig((current) => ({ ...current, [field]: value }));
  };
  const fieldError = (field: (typeof NUMERIC_FIELDS)[number]) => {
    const horizontalGeometry =
      preview.diagnosis === "radar.config.horizontalGeometry" &&
      (field === "width" || field === "marginLeft" || field === "marginRight");
    const verticalGeometry =
      preview.diagnosis === "radar.config.verticalGeometry" &&
      (field === "height" || field === "marginTop" || field === "marginBottom");
    return preview.diagnosis === `radar.config.${field}` ||
      horizontalGeometry ||
      verticalGeometry
      ? props.labels.invalidConfig
      : undefined;
  };
  return (
    <Stack gap="xs">
      {sourceConflict ? (
        <Alert color="myoxusWarning" variant="light">
          {props.labels.sourceChanged}
        </Alert>
      ) : null}
      <MyoxusText typographySlot="caption">
        {props.labels.configuration}
      </MyoxusText>
      <MyoxusSwitch
        checked={config.useMaxWidth}
        onChange={(useMaxWidth) =>
          setConfig((current) => ({ ...current, useMaxWidth }))
        }
      >
        {props.labels.configurationFields.useMaxWidth}
      </MyoxusSwitch>
      <Stack gap={0}>
        <MyoxusText typographySlot="caption">
          {props.labels.sourceValue(
            radarConfigSourceValue(props.model, "useMaxWidth") ??
              props.labels.automatic,
          )}
        </MyoxusText>
        <MyoxusText typographySlot="caption">
          {props.labels.effectiveValue(String(config.useMaxWidth))}
        </MyoxusText>
        <MyoxusText typographySlot="caption">
          {props.labels.defaultValue(
            String(DEFAULT_MERMAID_RADAR_CONFIG.useMaxWidth),
          )}
        </MyoxusText>
      </Stack>
      {NUMERIC_FIELDS.map((field) => (
        <Stack gap={0} key={field}>
          <NumberInput
            aria-label={props.labels.configurationFields[field]}
            error={fieldError(field)}
            min={
              field === "curveTension" || field.startsWith("margin")
                ? 0
                : undefined
            }
            label={props.labels.configurationFields[field]}
            onChange={(value) => setNumber(field, value)}
            value={config[field]}
          />
          <MyoxusText typographySlot="caption">
            {props.labels.sourceValue(
              radarConfigSourceValue(props.model, field) ??
                props.labels.automatic,
            )}
          </MyoxusText>
          <MyoxusText typographySlot="caption">
            {props.labels.effectiveValue(String(config[field]))}
          </MyoxusText>
          <MyoxusText typographySlot="caption">
            {props.labels.defaultValue(
              String(DEFAULT_MERMAID_RADAR_CONFIG[field]),
            )}
          </MyoxusText>
        </Stack>
      ))}
      <Group justify="space-between">
        <Button
          onClick={() => {
            setConfig(DEFAULT_MERMAID_RADAR_CONFIG);
          }}
          variant="plain"
        >
          {props.labels.reset}
        </Button>
        <Group>
          <Button onClick={onCancel} variant="plain">
            {props.labels.cancel}
          </Button>
          <Button
            disabled={sourceConflict || !preview.changed}
            onClick={() => preview.changed && onApply(desired)}
          >
            {props.labels.apply}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
