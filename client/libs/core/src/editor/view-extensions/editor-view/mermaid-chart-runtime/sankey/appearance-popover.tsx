// SPDX-License-Identifier: AGPL-3.0-or-later

import { ResetIcon } from "@myoxus/icons";
import {
  Badge,
  Button,
  ColorInput,
  Group,
  IconButton,
  MyoxusSwitch,
  MyoxusTextInput,
  NumberInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidSankeyReactHostProps,
  type SankeyCommand,
  type SankeyConfig,
} from "@virgultum/block-mermaid";
import { useState } from "react";

const fieldLabels: Record<
  Exclude<keyof SankeyConfig, "nodeColors">,
  () => string
> = {
  height: messages.xyHeight,
  labelStyle: messages.sankeyLabelStyle,
  linkColor: messages.sankeyLinkColor,
  nodeAlignment: messages.sankeyNodeAlignment,
  nodePadding: messages.sankeyNodePadding,
  nodeWidth: messages.sankeyNodeWidth,
  prefix: messages.sankeyPrefix,
  showValues: messages.sankeyShowValues,
  suffix: messages.sankeySuffix,
  useMaxWidth: messages.xyUseMaxWidth,
  width: messages.xyWidth,
};

const selectOptions = {
  labelStyle: [
    { value: "legacy", label: messages.sankeyLabelLegacy() },
    { value: "outlined", label: messages.sankeyLabelOutlined() },
  ],
  nodeAlignment: [
    { value: "left", label: messages.sankeyLayoutLeft() },
    { value: "right", label: messages.sankeyLayoutRight() },
    { value: "center", label: messages.sankeyLayoutCenter() },
    { value: "justify", label: messages.sankeyLayoutJustify() },
  ],
  linkColor: [
    { value: "gradient", label: messages.sankeyLinkGradient() },
    { value: "source", label: messages.chartSource() },
    { value: "target", label: messages.chartTarget() },
  ],
} as const;

const appearanceFields: readonly Exclude<keyof SankeyConfig, "nodeColors">[] = [
  "nodeAlignment",
  "showValues",
  "prefix",
  "suffix",
  "nodeWidth",
  "nodePadding",
  "labelStyle",
  "linkColor",
  "width",
  "height",
  "useMaxWidth",
];

export function SankeyAppearancePopover({
  onApply,
  onCancel,
  onPreviewConfig,
  props,
}: {
  readonly onApply: (commands: readonly SankeyCommand[]) => boolean;
  readonly onCancel: () => void;
  readonly onPreviewConfig: (config?: SankeyConfig) => void;
  readonly props: MermaidSankeyReactHostProps;
}) {
  const [changes, setChanges] = useState<Partial<SankeyConfig>>({});
  const commandsFor = (next: Partial<SankeyConfig>) =>
    Object.entries(next).map(([field, value]) => ({
      type: "config.set" as const,
      field: field as keyof SankeyConfig,
      value,
    }));
  const change = <K extends keyof SankeyConfig>(
    field: K,
    value: SankeyConfig[K] | undefined,
  ) => {
    const next = { ...changes, [field]: value };
    const result = props.onPreviewCommand(commandsFor(next));
    onPreviewConfig(result.changed ? result.model.config : props.model.config);
    setChanges(next);
  };
  const commands = commandsFor(changes);
  const preview = props.onPreviewCommand(commands);
  return (
    <Stack>
      {appearanceFields.map((field) => {
        const value = Object.hasOwn(changes, field)
          ? changes[field]
          : props.model.config[field];
        const options =
          field === "nodeAlignment" ||
          field === "labelStyle" ||
          field === "linkColor"
            ? selectOptions[field]
            : null;
        const standardLinkColor =
          field === "linkColor" &&
          ["gradient", "source", "target"].includes(String(value));
        return (
          <Group key={field} align="flex-end" wrap="nowrap">
            {field === "linkColor" ? (
              <Stack>
                <Select
                  label={fieldLabels[field]()}
                  data={[...selectOptions.linkColor]}
                  value={standardLinkColor ? String(value) : null}
                  onChange={(next) => change(field, next)}
                  disabled={props.readonly}
                />
                <ColorInput
                  allowEmpty
                  aria-label={fieldLabels[field]()}
                  value={standardLinkColor ? "" : String(value ?? "")}
                  onChange={(next) => change(field, next)}
                  disabled={props.readonly}
                />
              </Stack>
            ) : options ? (
              <Select
                label={fieldLabels[field]()}
                data={[...options]}
                value={typeof value === "string" ? value : null}
                onChange={(next) =>
                  change(field, next as SankeyConfig[typeof field])
                }
                disabled={props.readonly}
              />
            ) : typeof props.model.config[field] === "boolean" ? (
              <MyoxusSwitch
                checked={Boolean(value)}
                onChange={(next) => change(field, next)}
                disabled={props.readonly}
              >
                {fieldLabels[field]()}
              </MyoxusSwitch>
            ) : typeof props.model.config[field] === "number" ? (
              <NumberInput
                label={fieldLabels[field]()}
                value={typeof value === "number" ? value : ""}
                onChange={(next) =>
                  change(field, next === "" ? NaN : Number(next))
                }
                disabled={props.readonly}
              />
            ) : (
              <MyoxusTextInput
                label={fieldLabels[field]()}
                value={typeof value === "string" ? value : ""}
                onChange={(next) => change(field, next)}
                disabled={props.readonly}
              />
            )}
            <Badge>
              {preview.model.configOverrides.includes(field)
                ? messages.modeSource()
                : messages.optionDefault()}
            </Badge>
            <IconButton
              icon={<ResetIcon />}
              aria-label={messages.architectureReset()}
              tooltip={messages.architectureReset()}
              onClick={() => change(field, undefined)}
              disabled={props.readonly}
            />
          </Group>
        );
      })}
      <Group justify="flex-end">
        <Button
          variant="plain"
          onClick={() => {
            onPreviewConfig(undefined);
            onCancel();
          }}
        >
          {messages.cancel()}
        </Button>
        <Button
          disabled={props.readonly || !preview.changed}
          onClick={() => {
            onPreviewConfig(undefined);
            onApply(commands);
          }}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
