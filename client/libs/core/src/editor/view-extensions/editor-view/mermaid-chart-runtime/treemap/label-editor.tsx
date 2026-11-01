// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function TreemapLabelEditor({
  id,
  onApply,
  onCancel,
  props,
}: {
  readonly id: string;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const node = props.model.nodes.find((candidate) => candidate.id === id);
  const [label, setLabel] = useState(node?.label ?? "");
  const invalid = !label.trim() || (label.includes('"') && label.includes("'"));
  return (
    <Stack>
      <MyoxusTextInput
        autoFocus
        disabled={props.readonly}
        error={invalid ? messages.pieInvalid() : undefined}
        label={messages.selectedNodeLabel()}
        onChange={setLabel}
        value={label}
      />
      <MyoxusText typographySlot="caption">
        {node?.labelQuote === "single" ? `'${label}'` : `"${label}"`}
      </MyoxusText>
      {invalid ? <Alert role="status">{messages.pieInvalid()}</Alert> : null}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={invalid || label === node?.label}
          onClick={() => onApply({ type: "node.rename", id, label })}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
