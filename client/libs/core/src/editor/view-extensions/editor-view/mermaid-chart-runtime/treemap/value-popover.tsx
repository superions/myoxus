// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  MyoxusNumberInput,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function TreemapValuePopover({
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
  const [value, setValue] = useState<string | number>(node?.value ?? "");
  const valid =
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  return (
    <Stack>
      <MyoxusNumberInput
        autoFocus
        min={0}
        label={messages.value()}
        value={value}
        onChange={setValue}
      />
      <MyoxusText typographySlot="caption">
        {node?.valueLexeme ?? ""}
      </MyoxusText>
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={!valid || value === node?.value}
          onClick={() => valid && onApply({ type: "value.set", id, value })}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}
