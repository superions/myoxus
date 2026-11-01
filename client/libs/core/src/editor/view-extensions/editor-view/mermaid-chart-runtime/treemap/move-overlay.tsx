// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Group, Select, Stack } from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  treemapDescendantIds,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

export function TreemapMoveOverlay({
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
  const descendants = treemapDescendantIds(props.model, id);
  const [parentId, setParentId] = useState<string | null>(null);
  const choices = props.model.nodes.filter(
    (candidate) =>
      candidate.value === null &&
      candidate.renderable &&
      candidate.id !== id &&
      candidate.id !== node?.parentId &&
      !descendants.has(candidate.id),
  );
  return (
    <Stack>
      <Select
        autoFocus
        searchable
        label={messages.treemapParent()}
        data={choices.map((candidate) => ({
          label: candidate.label,
          value: candidate.id,
        }))}
        value={parentId}
        onChange={setParentId}
      />
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={
            !parentId ||
            (node?.parentId === null && props.model.roots.length === 1)
          }
          onClick={() =>
            parentId && onApply({ type: "hierarchy.reparent", id, parentId })
          }
        >
          {messages.treemapMove()}
        </Button>
      </Group>
    </Stack>
  );
}
