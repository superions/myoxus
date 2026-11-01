// SPDX-License-Identifier: AGPL-3.0-or-later

import { readMermaidGfxMeta } from "../mermaid-gfx-metadata.js";
import { prepareMermaidOwnerCopy } from "../commands/copy-identities.js";
import {
  type ClipboardConfigCreationContext,
  EdgelessClipboardConfig,
} from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

import { assignGfxProps, createMermaidBlockInsertProps } from "../commands.js";
import { resolveMermaidFamilyRuntime } from "../families/runtime/registry.js";
import { isMermaidBlockModel } from "./owner.js";
import { canProjectMermaidNatively } from "./owner.js";
import { coerceMermaidBlockText, coerceMermaidSource } from "../utils.js";

function oldChildIds(snapshot: BlockSnapshot) {
  const value = snapshot.props.childElementIds;
  return value && typeof value === "object" ? Object.keys(value) : [];
}

function ownerComments(
  snapshot: BlockSnapshot,
): Record<string, boolean> | undefined {
  const value = snapshot.props.comments;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const comments: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "boolean") return undefined;
    comments[key] = entry;
  }
  return comments;
}

export class MermaidEdgelessClipboardConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:mermaid";

  override createBlock(
    snapshot: BlockSnapshot,
    context: ClipboardConfigCreationContext,
  ): string | null {
    if (!this.surface || this.std.store.readonly) return null;

    const childIds = oldChildIds(snapshot);
    const cleanupChildren = () => {
      for (const oldId of childIds) {
        const pastedId = context.oldToNewIdMap.get(oldId);
        if (pastedId) this.crud.removeElement(pastedId);
      }
    };

    // Read the serialized delta directly: fromJSON creates an unattached
    // Y.Text whose content cannot be read until it joins a document.
    const source = coerceMermaidSource(snapshot.props.source);
    const title = coerceMermaidBlockText(snapshot.props.title);
    const resolution = resolveMermaidFamilyRuntime(source);
    if (!canProjectMermaidNatively(resolution)) {
      cleanupChildren();
      return null;
    }

    const children = [];
    for (const oldId of childIds) {
      const newId = context.oldToNewIdMap.get(oldId);
      if (!newId) {
        cleanupChildren();
        return null;
      }
      const child = this.crud.getElementById(newId);
      if (!child) {
        cleanupChildren();
        return null;
      }
      children.push(child);
    }

    const copy = prepareMermaidOwnerCopy(
      source,
      typeof snapshot.props.familyData === "string"
        ? snapshot.props.familyData
        : "",
      ownerComments(snapshot),
    );
    if (!copy) {
      cleanupChildren();
      return null;
    }
    for (const child of children) {
      const serialized: Record<string, unknown> = {};
      for (const key of [
        "mermaidNodeId",
        "mermaidEdgeSemanticSource",
        "mermaidEdgeSemanticTarget",
        "mermaidNodeFamilyData",
        "mermaidEdgeFamilyData",
      ])
        serialized[key] = readMermaidGfxMeta(child, key);
      assignGfxProps(child, copy.remapElement(serialized));
    }
    const ownerId = this.crud.addBlock(
      "myoxus:mermaid",
      {
        ...createMermaidBlockInsertProps({ source, title }),
        familyData: copy.familyData,
        comments: copy.comments,
        index: snapshot.props.index,
        lockedBySelf: false,
        rotate: snapshot.props.rotate,
        xywh: snapshot.props.xywh,
      },
      this.surface.model.id,
    );
    const owner = ownerId ? this.std.store.getBlock(ownerId)?.model : null;
    if (!isMermaidBlockModel(owner)) {
      if (ownerId) this.crud.removeElement(ownerId);
      cleanupChildren();
      return null;
    }
    owner.addChildren(children);
    if (children.some((child) => !owner.hasChild(child))) {
      this.crud.removeElement(ownerId);
      cleanupChildren();
      return null;
    }
    return ownerId;
  }
}
