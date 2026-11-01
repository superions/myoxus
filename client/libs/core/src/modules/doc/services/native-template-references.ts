// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlockSnapshot, Transformer } from "@virgultum/store";

import { TemplateInstantiationError } from "../../template-doc/services/template-instantiation-error";

type Snapshot = NonNullable<ReturnType<Transformer["sliceToSnapshot"]>>;

/** Ordinary Library copies have no contextual target. Remove only the closed
 * optional slots from the isolated native Slice before any target is created.
 * Bound references and the persisted source remain untouched.
 */
export function removeUnboundTemplateReferences(snapshot: Snapshot): void {
  const slots = new Set<BlockSnapshot>();
  const keys = new Set<string>();
  const invalid = (): never => {
    throw new TemplateInstantiationError("invalid-syntax");
  };
  const inspect = (blocks: BlockSnapshot[], parent: string) => {
    for (const block of blocks) {
      const marker = block.props.templateReference;
      if (marker !== undefined) {
        if (!marker || typeof marker !== "object" || Array.isArray(marker))
          invalid();
        const record = marker as Record<string, unknown>;
        const kind =
          record.key === "context.container"
            ? "database"
            : record.key === "context.task"
              ? "task"
              : undefined;
        if (
          !kind ||
          record.kind !== kind ||
          record.optional !== true ||
          Object.keys(record).length !== 3 ||
          Object.keys(record).some(
            (key) => !["key", "kind", "optional"].includes(key),
          ) ||
          keys.has(String(record.key)) ||
          block.flavour !== "myoxus:database" ||
          parent !== "myoxus:note" ||
          block.children.length !== 0 ||
          block.props.serverReferencePresentation !== "compact" ||
          Object.entries(block.props).some(([key, value]) => {
            if (
              key === "templateReference" ||
              key === "serverReferencePresentation"
            )
              return false;
            if (key === "serverViewId")
              return value !== undefined && value !== null;
            return (
              ![
                "serverWorkspaceId",
                "serverDatabaseId",
                "serverRowId",
              ].includes(key) || value !== undefined
            );
          })
        )
          invalid();
        keys.add(String(record.key));
        slots.add(block);
      }
      inspect(block.children, block.flavour);
    }
  };
  inspect(snapshot.content, "myoxus:page");
  const remove = (blocks: BlockSnapshot[]): BlockSnapshot[] =>
    blocks.filter((block) => {
      if (slots.has(block)) return false;
      block.children = remove(block.children);
      return true;
    });
  snapshot.content = remove(snapshot.content);
}
