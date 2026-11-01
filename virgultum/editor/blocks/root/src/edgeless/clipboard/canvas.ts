import {
  CanvasElementType,
  type ClipboardConfigCreationContext,
  EdgelessCRUDIdentifier,
} from "@virgultum/block-surface";
import { Bound, type SerializedXYWH, Vec } from "@virgultum/global/gfx";
import type { Connection } from "@virgultum/model";
import { TelemetryProvider } from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import type {
  GfxPrimitiveElementModel,
  SerializedElement,
} from "@virgultum/std/gfx";
import * as Y from "yjs";

const { GROUP, CONNECTOR } = CanvasElementType;

export function createCanvasElement(
  std: BlockStdScope,
  clipboardData: SerializedElement,
  context: ClipboardConfigCreationContext,
  newXYWH: SerializedXYWH,
) {
  if (clipboardData.type === GROUP) {
    const yMap = new Y.Map();
    const children = clipboardData.children ?? {};

    for (const [key, value] of Object.entries(children)) {
      const newKey = context.oldToNewIdMap.get(key);
      if (!newKey) {
        console.error(
          `Copy failed: cannot find the copied child in group, key: ${key}`,
        );
        return null;
      }
      yMap.set(newKey, value);
    }
    clipboardData.children = yMap;
    clipboardData.xywh = newXYWH;
  } else if (clipboardData.type === CONNECTOR) {
    const source = clipboardData.source as Connection;
    const target = clipboardData.target as Connection;

    const oldBound = Bound.deserialize(clipboardData.xywh);
    const newBound = Bound.deserialize(newXYWH);
    const offset = Vec.sub([newBound.x, newBound.y], [oldBound.x, oldBound.y]);

    if (source.id) {
      source.id = context.oldToNewIdMap.get(source.id) ?? source.id;
    } else if (source.position) {
      source.position = Vec.add(source.position, offset);
    }

    if (target.id) {
      target.id = context.oldToNewIdMap.get(target.id) ?? target.id;
    } else if (target.position) {
      target.position = Vec.add(target.position, offset);
    }
  } else {
    clipboardData.xywh = newXYWH;
  }

  clipboardData.lockedBySelf = false;

  const crud = std.get(EdgelessCRUDIdentifier);

  const id = crud.addElement(
    clipboardData.type as CanvasElementType,
    clipboardData,
  );
  if (!id) {
    return null;
  }
  std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
    control: "canvas:paste",
    page: "whiteboard editor",
    module: "toolbar",
    segment: "toolbar",
    type: clipboardData.type as string,
  });
  const element = crud.getElementById(id) as GfxPrimitiveElementModel;
  if (!element) {
    console.error(`Copy failed: cannot find the copied element, id: ${id}`);
    return null;
  }
  // Mermaid projection metadata is persisted beside the primitive fields.
  // Surface construction initializes only schema fields; restore this existing
  // namespace before a pasted Mermaid owner validates and adopts its children.
  for (const [key, value] of Object.entries(clipboardData))
    if (key.startsWith("mermaid")) element.yMap.set(key, value);
  return element;
}
