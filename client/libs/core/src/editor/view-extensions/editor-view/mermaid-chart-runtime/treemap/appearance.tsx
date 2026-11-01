// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusNumberInput,
  MyoxusTextInput,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  validTreemapConfigField,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
  type TreemapConfig,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

const numericFields = [
  "padding",
  "diagramPadding",
  "nodeWidth",
  "nodeHeight",
  "borderWidth",
  "valueFontSize",
  "labelFontSize",
] as const;

function numericLabel(field: (typeof numericFields)[number]) {
  return field === "padding"
    ? messages.treemapPadding()
    : field === "diagramPadding"
      ? messages.treemapDiagramPadding()
      : field === "nodeWidth"
        ? messages.treemapNodeWidth()
        : field === "nodeHeight"
          ? messages.treemapNodeHeight()
          : field === "borderWidth"
            ? messages.treemapBorderWidth()
            : field === "valueFontSize"
              ? messages.treemapValueFontSize()
              : messages.treemapLabelFontSize();
}

export function TreemapAppearance({
  onApply,
  onPreview,
  props,
}: {
  readonly onApply: (
    command: TreemapCommand | readonly TreemapCommand[],
  ) => boolean;
  readonly onPreview: (config?: TreemapConfig) => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const [draft, setDraft] = useState<TreemapConfig>(props.model.config);
  useEffect(() => {
    setDraft(props.model.config);
  }, [props.model.config]);
  const update = <K extends keyof TreemapConfig>(
    field: K,
    value: TreemapConfig[K],
  ) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    onPreview(next);
  };
  const changed = (Object.keys(draft) as Array<keyof TreemapConfig>).filter(
    (field) => draft[field] !== props.model.config[field],
  );
  const reset = (field: keyof TreemapConfig) => {
    if (onApply({ type: "appearance.reset", field })) onPreview(undefined);
  };
  const overridden = new Set(props.model.configOverrides);
  const formatValid = validTreemapConfigField("valueFormat", draft.valueFormat);
  return (
    <Stack>
      {(["useMaxWidth", "showValues"] as const).map((field) => (
        <Group key={field} justify="space-between" wrap="nowrap">
          <Switch
            checked={draft[field]}
            disabled={props.readonly}
            onChange={(value) => update(field, value)}
          >
            {field === "useMaxWidth"
              ? messages.treemapUseMaxWidth()
              : messages.treemapShowValues()}
          </Switch>
          {overridden.has(field) ? (
            <Button
              variant="plain"
              disabled={props.readonly}
              onClick={() => reset(field)}
            >
              {messages.resetOverride()}
            </Button>
          ) : null}
        </Group>
      ))}
      {numericFields.map((field) => (
        <Group key={field} align="flex-end" wrap="nowrap">
          <MyoxusNumberInput
            description={
              field === "borderWidth" ||
              field === "valueFontSize" ||
              field === "labelFontSize"
                ? messages.treemapRuntimeNoop()
                : undefined
            }
            disabled={props.readonly}
            min={
              field === "nodeWidth" ||
              field === "nodeHeight" ||
              field === "valueFontSize" ||
              field === "labelFontSize"
                ? 1
                : 0
            }
            label={numericLabel(field)}
            value={draft[field]}
            onChange={(value) =>
              typeof value === "number" && update(field, value)
            }
          />
          {overridden.has(field) ? (
            <Button
              variant="plain"
              disabled={props.readonly}
              onClick={() => reset(field)}
            >
              {messages.resetOverride()}
            </Button>
          ) : null}
        </Group>
      ))}
      <Group align="flex-end" wrap="nowrap">
        <MyoxusTextInput
          disabled={props.readonly}
          error={!formatValid ? messages.pieInvalid() : undefined}
          label={messages.treemapValueFormat()}
          value={draft.valueFormat}
          onChange={(value) => update("valueFormat", value)}
        />
        {overridden.has("valueFormat") ? (
          <Button
            variant="plain"
            disabled={props.readonly}
            onClick={() => reset("valueFormat")}
          >
            {messages.resetOverride()}
          </Button>
        ) : null}
      </Group>
      <Alert role="note">{messages.treemapSourceOverride()}</Alert>
      <Group justify="flex-end">
        <Button
          variant="plain"
          onClick={() => {
            setDraft(props.model.config);
            onPreview(undefined);
          }}
        >
          {messages.cancel()}
        </Button>
        <Button
          disabled={props.readonly || !changed.length || !formatValid}
          onClick={() =>
            onApply(
              changed.map(
                (field) =>
                  ({
                    type: "appearance.set",
                    field,
                    value: draft[field],
                  }) as TreemapCommand,
              ),
            )
          }
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
