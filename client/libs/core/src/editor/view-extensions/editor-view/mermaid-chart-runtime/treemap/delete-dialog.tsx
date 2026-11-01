// SPDX-License-Identifier: AGPL-3.0-or-later

import { Alert, Button, Group, Stack } from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  treemapDeleteImpact,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
} from "@virgultum/block-mermaid";

export function TreemapDeleteDialog({
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
  const impact = treemapDeleteImpact(props.model, id);
  if (!impact) return null;
  const canPromote =
    impact.directChildren > 0 &&
    (impact.node.parentId !== null || impact.directChildren === 1);
  return (
    <Stack>
      <Alert role="status">
        {messages.treemapDeleteImpact({
          label: impact.node.label,
          children: impact.directChildren,
          nodes: impact.subtreeSize,
          leaves: impact.leaves,
          value: impact.value,
          comments: impact.comments,
          classes: impact.classes,
        })}
      </Alert>
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        {canPromote ? (
          <Button
            variant="plain"
            onClick={() =>
              onApply({
                type: "node.delete",
                id,
                strategy: "promote",
                confirmed: true,
              })
            }
          >
            {messages.treemapPromoteChildren()}
          </Button>
        ) : null}
        <Button
          color="myoxusError"
          onClick={() =>
            onApply({
              type: "node.delete",
              id,
              strategy: "subtree",
              confirmed: true,
            })
          }
        >
          {messages.treemapDeleteSubtree()}
        </Button>
      </Group>
    </Stack>
  );
}
