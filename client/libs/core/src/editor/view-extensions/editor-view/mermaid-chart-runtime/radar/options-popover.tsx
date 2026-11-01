// SPDX-License-Identifier: AGPL-3.0-or-later

import { SettingsIcon } from "@myoxus/icons";
import {
  Alert,
  Button,
  CountIndicator,
  Group,
  IconButton,
  MyoxusSegmentedControl,
  MyoxusSwitch,
  MyoxusText,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import type {
  MermaidRadarConfig,
  MermaidRadarModel,
  MermaidRadarOptionsCommand,
  MermaidRadarReactHostProps,
} from "@virgultum/block-mermaid";
import { DEFAULT_MERMAID_RADAR_OPTIONS } from "@virgultum/block-mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

import { MermaidRadarCommentsEditor } from "./comments";
import { MermaidRadarConfigEditor } from "./config-popover";
import { radarOptionSourceValue, radarOptionsSourceKey } from "./source-values";

type RadarOptionsDraft = {
  readonly graticule: "circle" | "polygon";
  readonly max: number | string | null;
  readonly min: number | string;
  readonly showLegend: boolean;
  readonly ticks: number | string;
};

function optionsCommand(
  options: RadarOptionsDraft,
  explicitMax: boolean,
): MermaidRadarOptionsCommand {
  return {
    graticule: options.graticule,
    max:
      explicitMax && typeof options.max === "number"
        ? options.max
        : explicitMax
          ? Number.NaN
          : null,
    min: typeof options.min === "number" ? options.min : Number.NaN,
    showLegend: options.showLegend,
    ticks: typeof options.ticks === "number" ? options.ticks : Number.NaN,
    type: "options.apply",
  };
}

function optionsDraftFromModel(model: MermaidRadarModel) {
  const options = {
    graticule: model.options.effective.graticule,
    max: model.options.explicit.max ?? null,
    min: model.options.effective.minimum,
    showLegend: model.options.effective.showLegend,
    ticks: model.options.explicit.ticks ?? model.options.effective.ticks,
  } satisfies RadarOptionsDraft;
  return { explicitMax: options.max !== null, options };
}

function optionsDraftKey(options: RadarOptionsDraft, explicitMax: boolean) {
  return JSON.stringify({ explicitMax, options });
}

export function MermaidRadarOptionsPopover({
  onApplyConfig,
  onApplyOptions,
  onCommentCommand,
  onOpenedChange,
  onPreview,
  opened,
  props,
}: {
  readonly onApplyConfig: (config: Required<MermaidRadarConfig>) => boolean;
  readonly onApplyOptions: (
    options: Omit<MermaidRadarOptionsCommand, "type">,
  ) => boolean;
  readonly onCommentCommand: Parameters<
    typeof MermaidRadarCommentsEditor
  >[0]["onCommand"];
  readonly onOpenedChange: (opened: boolean) => void;
  readonly onPreview: (model: MermaidRadarModel | null) => void;
  readonly opened: boolean;
  readonly props: MermaidRadarReactHostProps;
}) {
  const initial = optionsDraftFromModel(props.model);
  const [options, setOptions] = useState<RadarOptionsDraft>(initial.options);
  const [explicitMax, setExplicitMax] = useState(options.max !== null);
  const [commentDraft, setCommentDraft] = useState("");
  const [sourceConflict, setSourceConflict] = useState(false);
  const openedRef = useRef(false);
  const baseRef = useRef({
    draftKey: optionsDraftKey(initial.options, initial.explicitMax),
    ownerKey: radarOptionsSourceKey(props.model),
    sourceHash: props.model.sourceHash,
  });
  const draftRef = useRef({ explicitMax, options });
  draftRef.current = { explicitMax, options };
  useEffect(() => {
    if (!opened) {
      openedRef.current = false;
      return;
    }
    const next = optionsDraftFromModel(props.model);
    const nextBase = {
      draftKey: optionsDraftKey(next.options, next.explicitMax),
      ownerKey: radarOptionsSourceKey(props.model),
      sourceHash: props.model.sourceHash,
    };
    if (!openedRef.current) {
      openedRef.current = true;
      baseRef.current = nextBase;
      setOptions(next.options);
      setExplicitMax(next.explicitMax);
      setSourceConflict(false);
      return;
    }
    if (baseRef.current.sourceHash === nextBase.sourceHash) return;
    const ownerChanged = baseRef.current.ownerKey !== nextBase.ownerKey;
    const draftChanged =
      optionsDraftKey(
        draftRef.current.options,
        draftRef.current.explicitMax,
      ) !== baseRef.current.draftKey;
    if (ownerChanged && draftChanged) {
      setSourceConflict(true);
      return;
    }
    baseRef.current = nextBase;
    setSourceConflict(false);
    if (ownerChanged) {
      setOptions(next.options);
      setExplicitMax(next.explicitMax);
    }
  }, [opened, props.model.sourceHash]);
  const command = useMemo(
    () => optionsCommand(options, explicitMax),
    [explicitMax, options],
  );
  const preview = useMemo(
    () => props.onPreviewCommand(command),
    [command, props.onPreviewCommand],
  );
  const previewModel = preview.changed ? preview.model : undefined;
  useEffect(() => {
    onPreview(opened && previewModel ? previewModel : null);
    return () => onPreview(null);
  }, [onPreview, opened, previewModel]);
  const effective =
    previewModel?.options.effective ?? props.model.options.effective;
  const clipped = (previewModel ?? props.model).curves.reduce(
    (count, curve) =>
      count +
      curve.vertices.filter(
        (vertex) =>
          vertex.state === "clipped-high" || vertex.state === "clipped-low",
      ).length,
    0,
  );
  const optionsRecord = props.model.sourceDocument.records.findLast(
    (record) => record.kind === "options",
  );
  return (
    <Popover
      fitViewport
      onChange={onOpenedChange}
      opened={opened}
      position="bottom-end"
    >
      <PopoverTarget>
        <CountIndicator
          count={
            props.model.comments.filter(
              (comment) => comment.anchor.kind === "options",
            ).length
          }
        >
          <IconButton
            aria-label={props.labels.options}
            icon={<SettingsIcon />}
            onClick={() => onOpenedChange(!opened)}
            tooltip={props.labels.options}
            tooltipOptions={opened ? { opened: false } : undefined}
          />
        </CountIndicator>
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating" offsetScrollbars="y">
          <Tabs defaultValue="options" layout="embedded">
            <TabsList>
              <TabsTrigger grow value="options">
                {props.labels.options}
              </TabsTrigger>
              <TabsTrigger grow value="config">
                {props.labels.configuration}
              </TabsTrigger>
            </TabsList>
            <TabsContent forceMount={false} value="options">
              <Stack gap="xs">
                {sourceConflict ? (
                  <Alert color="myoxusWarning" variant="light">
                    {props.labels.sourceChanged}
                  </Alert>
                ) : null}
                {preview.diagnosis === "radar.options-comments-present" ? (
                  <Alert color="myoxusWarning" variant="light">
                    {props.labels.commentOwnerRemovalBlocked}
                  </Alert>
                ) : null}
                <Stack gap={0}>
                  <MyoxusText typographySlot="caption">
                    {props.labels.sourceValue(
                      radarOptionSourceValue(props.model, "showLegend") ??
                        props.labels.automatic,
                    )}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.effectiveValue(String(effective.showLegend))}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.defaultValue(
                      String(DEFAULT_MERMAID_RADAR_OPTIONS.showLegend),
                    )}
                  </MyoxusText>
                </Stack>
                <MyoxusSwitch
                  checked={options.showLegend}
                  onChange={(showLegend) =>
                    setOptions((current) => ({ ...current, showLegend }))
                  }
                >
                  {props.labels.showLegend}
                </MyoxusSwitch>
                <NumberInput
                  aria-label={props.labels.ticks}
                  error={
                    preview.diagnosis === "radar.options.ticks"
                      ? props.labels.invalidNumber
                      : undefined
                  }
                  min={0}
                  label={props.labels.ticks}
                  onChange={(ticks) =>
                    setOptions((current) => ({ ...current, ticks }))
                  }
                  value={options.ticks}
                />
                <Stack gap={0}>
                  <MyoxusText typographySlot="caption">
                    {props.labels.sourceValue(
                      radarOptionSourceValue(props.model, "ticks") ??
                        props.labels.automatic,
                    )}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.effectiveValue(String(effective.ticks))}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.defaultValue(
                      String(DEFAULT_MERMAID_RADAR_OPTIONS.ticks),
                    )}
                  </MyoxusText>
                </Stack>
                <NumberInput
                  aria-label={props.labels.minimum}
                  error={
                    preview.diagnosis === "radar.options.min" ||
                    preview.diagnosis === "radar.options.range"
                      ? preview.diagnosis === "radar.options.min"
                        ? props.labels.invalidNumber
                        : props.labels.invalidRange
                      : undefined
                  }
                  min={0}
                  label={props.labels.minimum}
                  onChange={(min) =>
                    setOptions((current) => ({ ...current, min }))
                  }
                  value={options.min}
                />
                <Stack gap={0}>
                  <MyoxusText typographySlot="caption">
                    {props.labels.sourceValue(
                      radarOptionSourceValue(props.model, "min") ??
                        props.labels.automatic,
                    )}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.effectiveValue(String(effective.minimum))}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.defaultValue(
                      String(DEFAULT_MERMAID_RADAR_OPTIONS.min),
                    )}
                  </MyoxusText>
                </Stack>
                <MyoxusSwitch checked={explicitMax} onChange={setExplicitMax}>
                  {props.labels.maximum}
                </MyoxusSwitch>
                {explicitMax ? (
                  <NumberInput
                    aria-label={props.labels.maximum}
                    error={
                      preview.diagnosis === "radar.options.max"
                        ? props.labels.invalidNumber
                        : preview.diagnosis === "radar.options.range"
                          ? props.labels.invalidRange
                          : undefined
                    }
                    min={0}
                    label={props.labels.maximum}
                    onChange={(max) =>
                      setOptions((current) => ({ ...current, max }))
                    }
                    value={options.max ?? ""}
                  />
                ) : null}
                <Stack gap={0}>
                  <MyoxusText typographySlot="caption">
                    {props.labels.sourceValue(
                      radarOptionSourceValue(props.model, "max") ??
                        props.labels.automatic,
                    )}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.effectiveValue(
                      effective.maximum === null
                        ? props.labels.automatic
                        : String(effective.maximum),
                    )}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.defaultValue(props.labels.automatic)}
                  </MyoxusText>
                </Stack>
                {!explicitMax && preview.diagnosis === "radar.options.range" ? (
                  <MyoxusText typographySlot="caption">
                    {props.labels.invalidRange}
                  </MyoxusText>
                ) : null}
                <MyoxusSegmentedControl
                  aria-label={props.labels.graticule}
                  data={[
                    { label: props.labels.circle, value: "circle" },
                    { label: props.labels.polygon, value: "polygon" },
                  ]}
                  layout="fluid"
                  onChange={(graticule) =>
                    setOptions((current) => ({
                      ...current,
                      graticule: graticule as "circle" | "polygon",
                    }))
                  }
                  value={options.graticule}
                />
                <Stack gap={0}>
                  <MyoxusText typographySlot="caption">
                    {props.labels.sourceValue(
                      radarOptionSourceValue(props.model, "graticule") ??
                        props.labels.automatic,
                    )}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.effectiveValue(effective.graticule)}
                  </MyoxusText>
                  <MyoxusText typographySlot="caption">
                    {props.labels.defaultValue(
                      DEFAULT_MERMAID_RADAR_OPTIONS.graticule,
                    )}
                  </MyoxusText>
                </Stack>
                {clipped ? (
                  <MyoxusText typographySlot="caption">
                    {props.labels.clippedVertices(clipped)}
                  </MyoxusText>
                ) : null}
                {optionsRecord ? (
                  <MermaidRadarCommentsEditor
                    anchor={{
                      id: optionsRecord.id,
                      kind: "options",
                    }}
                    draft={commentDraft}
                    includeAnchorKind
                    onCommand={onCommentCommand}
                    onDraftChange={setCommentDraft}
                    props={props}
                  />
                ) : null}
                <Group justify="flex-end">
                  <Button onClick={() => onOpenedChange(false)} variant="plain">
                    {props.labels.cancel}
                  </Button>
                  <Button
                    disabled={sourceConflict || !preview.changed}
                    onClick={() => {
                      const { type: _type, ...desired } = command;
                      if (preview.changed && onApplyOptions(desired))
                        onOpenedChange(false);
                    }}
                  >
                    {props.labels.apply}
                  </Button>
                </Group>
              </Stack>
            </TabsContent>
            <TabsContent forceMount={false} value="config">
              <MermaidRadarConfigEditor
                onApply={(config) => {
                  const applied = onApplyConfig(config);
                  if (applied) onOpenedChange(false);
                  return applied;
                }}
                onCancel={() => onOpenedChange(false)}
                onPreview={onPreview}
                props={props}
              />
            </TabsContent>
          </Tabs>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
