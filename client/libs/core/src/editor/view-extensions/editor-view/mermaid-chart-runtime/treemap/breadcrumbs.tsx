// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Group, Select } from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  treemapChildren,
  type TreemapModel,
} from "@virgultum/block-mermaid";

export function TreemapBreadcrumbs({
  model,
  nodeId,
  onSelect,
}: {
  readonly model: TreemapModel;
  readonly nodeId?: string;
  readonly onSelect: (id: string) => void;
}) {
  const path = [];
  let current = model.nodes.find((node) => node.id === nodeId);
  while (current) {
    path.unshift(current);
    current = current.parentId
      ? model.nodes.find((node) => node.id === current!.parentId)
      : undefined;
  }
  const selected = path.at(-1);
  const children = selected ? treemapChildren(model, selected.id) : [];
  if (!path.length) return null;
  return (
    <Group wrap="wrap">
      {path.map((node) => (
        <Button key={node.id} variant="plain" onClick={() => onSelect(node.id)}>
          {node.label}
        </Button>
      ))}
      {children.length ? (
        <Select
          aria-label={messages.treemapData()}
          clearable
          searchable
          data={children.map((node) => ({
            label: `${node.label} - ${node.value === null ? messages.treemapSection() : `${messages.treemapLeaf()} ${node.value}`}`,
            value: node.id,
          }))}
          onChange={(id) => id && onSelect(id)}
          placeholder={messages.treemapData()}
          value={null}
        />
      ) : null}
    </Group>
  );
}
