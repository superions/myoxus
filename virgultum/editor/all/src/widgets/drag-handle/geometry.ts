// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type CalloutBlockComponent,
  ParagraphBlockComponent,
} from "@virgultum/content/blocks";
import { ListBlockModel, ParagraphBlockModel } from "@virgultum/core/models";
import {
  Bound,
  type IVec,
  Point,
  Rect,
  type SerializedXYWH,
} from "@virgultum/core/primitives/gfx";
import type { BlockComponent, EditorHost } from "@virgultum/core/runtime";
import {
  GfxBlockElementModel,
  type GfxController,
  type GfxModel,
} from "@virgultum/core/runtime/gfx";
import { DocModeProvider, EmbedIframeService } from "@virgultum/core/services";
import {
  type BlockModel,
  type BlockSnapshot,
  internalPrimitives,
  type SliceSnapshot,
} from "@virgultum/core/store";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import {
  findClosestBlockComponent,
  getClosestBlockComponentByPoint,
  getSelectedRect,
  matchModels,
} from "@virgultum/core/utils";
import {
  EMBED_IFRAME_DEFAULT_HEIGHT_IN_SURFACE,
  EMBED_IFRAME_DEFAULT_WIDTH_IN_SURFACE,
  EdgelessNoteBackground,
  EdgelessNoteBlockComponent,
  MYOXUS_EDGELESS_NOTE,
} from "@virgultum/embeds/blocks";
import type { BlockStdScope } from "@virgultum/core/runtime";
import type { EmbedCardStyle } from "@virgultum/core/models";

export const HANDLE_CONTAINER_WIDTH = 16;
export const HANDLE_CONTAINER_PADDING = 8;
export const HANDLE_GRABBER_HEIGHT = 12;
export const HANDLE_GRABBER_WIDTH = 4;
export const HANDLE_GRABBER_WIDTH_ACTIVE = 2;
export const HANDLE_GRABBER_RADIUS = 4;
export const HOVER_RECT_PADDING = 4;

const HANDLE_OFFSET_LEFT_DEFAULT = 2;
const HANDLE_OFFSET_LEFT_TOGGLE = 18;
const NOTE_OUTER_PADDING = 24;
const EDGELESS_NOTE_MARGIN = 20;
const GFX_HANDLE_WIDTH = 8;
const GFX_HANDLE_OFFSET_LEFT = 5;
const GFX_HOVER_PADDING = 6;

const FIRST_LINE_HEIGHT_BY_TYPE: Record<string, number> = {
  text: 23,
  h1: 40,
  h2: 36,
  h3: 32,
  h4: 32,
  h5: 28,
  h6: 26,
  quote: 46,
  list: 24,
  database: 28,
  image: 28,
  divider: 36,
};

export interface GfxHandleArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function getFirstLineHeight(model: BlockModel): number {
  const separator = model.flavour.indexOf(":");
  let key = separator >= 0 ? model.flavour.slice(separator + 1) : model.flavour;
  if (key === "paragraph") {
    const paragraphType = (model as ParagraphBlockModel).props.type;
    if (paragraphType) key = paragraphType;
  }
  return FIRST_LINE_HEIGHT_BY_TYPE[key] ?? 24;
}

export function isDescendantOfAny(
  ancestors: BlockComponent[],
  candidate: BlockModel,
): boolean {
  return ancestors.some((ancestor) => {
    let cursor: BlockModel | null = candidate;
    while (cursor) {
      if (cursor.id === ancestor.model.id) return true;
      cursor = ancestor.store.getParent(cursor.id);
    }
    return false;
  });
}

export function getParentNoteElement(block: BlockComponent): Element | null {
  return block.closest("myoxus-note, myoxus-edgeless-note");
}

export function isPointOutsideNote(
  host: EditorHost,
  noteEl: Element,
  point: Point,
  scale: number,
): boolean {
  const rect = noteEl.getBoundingClientRect();
  const isPage = host.std.get(DocModeProvider).getEditorMode() === "page";
  const padding =
    (NOTE_OUTER_PADDING + (isPage ? 0 : EDGELESS_NOTE_MARGIN)) * scale;

  if (point.y < rect.top || point.y > rect.bottom) return true;
  if (point.x > rect.right + padding) return true;
  if (!isPage && point.x < rect.left - padding) return true;
  return false;
}

function findEdgelessNoteAtPoint(point: Point): Element | null {
  for (const el of document.elementsFromPoint(point.x, point.y)) {
    if (el instanceof EdgelessNoteBlockComponent) {
      return el;
    }
    if (el instanceof EdgelessNoteBackground) {
      return el.closest(MYOXUS_EDGELESS_NOTE);
    }
  }
  return null;
}

export function findNoteUnderPoint(
  host: EditorHost,
  root: BlockComponent,
  point: Point,
): BlockComponent | null {
  const isPage = host.std.get(DocModeProvider).getEditorMode() === "page";
  return (
    isPage
      ? findClosestBlockComponent(root, point, "myoxus-note")
      : findEdgelessNoteAtPoint(point)
  ) as BlockComponent | null;
}

export function findBlockUnderPoint(
  host: EditorHost,
  root: BlockComponent,
  point: Point,
): BlockComponent | null {
  const note = findNoteUnderPoint(host, root, point);
  if (!note || note.closest(".myoxus-surface-ref")) return null;

  const noteRect = Rect.fromDOM(note);
  const directHit = getClosestBlockComponentByPoint(point, {
    container: note,
    rect: noteRect,
  }) as BlockComponent | null;

  const fallbackSelector =
    ".myoxus-note-block-container > .myoxus-block-children-container > [data-block-id]";
  const resolved = (
    directHit && isDescendantOfAny([note], directHit.model)
      ? directHit
      : findClosestBlockComponent(note, point.clone(), fallbackSelector)
  ) as BlockComponent | null;

  if (!resolved || resolved.closest(".surface-ref-note-portal")) return null;

  if (matchModels(resolved.model, [ParagraphBlockModel])) {
    const callout = resolved.closest<CalloutBlockComponent>("myoxus-callout");
    if (callout) return callout;
  }

  return resolved;
}

export function getHandleLeftInset(blocks: BlockComponent[]): number {
  const needsToggleClearance = blocks.some(
    (block) =>
      (matchModels(block.model, [ListBlockModel]) &&
        block.model.children.length > 0) ||
      (block instanceof ParagraphBlockComponent &&
        block.model.props.type.startsWith("h") &&
        block.collapsedSiblings.length > 0),
  );
  return needsToggleClearance
    ? HANDLE_OFFSET_LEFT_TOGGLE
    : HANDLE_OFFSET_LEFT_DEFAULT;
}

export function computeBlockAreaRect(
  anchor: BlockComponent,
  coveredBlocks: BlockComponent[],
  offsetParent: Element,
  scaleInNote: number,
): Rect {
  let { left, top, right, bottom } = anchor.getBoundingClientRect();
  for (const block of coveredBlocks) {
    const rect = block.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  const parentRect = offsetParent.getBoundingClientRect();
  const insetLeft = getHandleLeftInset(coveredBlocks);

  left =
    left - parentRect.left - (HANDLE_CONTAINER_WIDTH + insetLeft) * scaleInNote;
  top = top - parentRect.top - HOVER_RECT_PADDING * scaleInNote;
  right = right - parentRect.left + HOVER_RECT_PADDING * scaleInNote;
  bottom = bottom - parentRect.top + HOVER_RECT_PADDING * scaleInNote;

  return new Rect(left, top, right, bottom);
}

export function computeGfxHandleArea(
  gfx: GfxController,
  element: GfxModel,
  scale: number,
): GfxHandleArea {
  const modelRect = getSelectedRect([element]);
  let [left, top] = gfx.viewport.toViewCoord(modelRect.left, modelRect.top);
  const width = modelRect.width * scale;
  const height = modelRect.height * scale;
  const padding = GFX_HOVER_PADDING * scale;
  const handleWidth = GFX_HANDLE_WIDTH * scale;

  const right = left + width + padding;
  const bottom = top + height + padding;
  left -= handleWidth + GFX_HANDLE_OFFSET_LEFT;

  return { left, top, right, bottom, width, height };
}

export function collectSnapshotIds(snapshot: SliceSnapshot): string[] {
  const ids: string[] = [];
  const walk = (block: BlockSnapshot) => {
    ids.push(block.id);
    for (const child of block.children ?? []) {
      walk(child);
    }
  };
  for (const root of snapshot.content) {
    walk(root);
  }
  return ids;
}

export function computeSnapshotBound(snapshot: SliceSnapshot): Bound | null {
  let combined: Bound | null = null;
  const include = (next: Bound) => {
    combined = combined ? combined.unite(next) : next;
  };

  const walk = (block: BlockSnapshot) => {
    if (block.flavour === "myoxus:surface") {
      const elements = (block.props.elements ?? {}) as Record<
        string,
        { xywh?: SerializedXYWH }
      >;
      for (const elem of Object.values(elements)) {
        if (elem.xywh) include(Bound.deserialize(elem.xywh));
      }
      for (const child of block.children ?? []) walk(child);
      return;
    }
    if (block.props.xywh) {
      include(Bound.deserialize(block.props.xywh as SerializedXYWH));
    }
  };

  for (const root of snapshot.content) walk(root);
  return combined;
}

export function repositionSnapshot(
  std: BlockStdScope,
  snapshot: SliceSnapshot,
  targetPoint: Point,
  resetOrigin = false,
): void {
  const originBound = computeSnapshotBound(snapshot) ?? new Bound(0, 0, 0, 0);
  const dx = targetPoint.x - originBound.x;
  const dy = targetPoint.y - originBound.y;

  const rewrite = (block: BlockSnapshot) => {
    if (block.flavour === "myoxus:surface") {
      const elements = (block.props.elements ?? {}) as Record<
        string,
        {
          type: string;
          xywh?: SerializedXYWH;
          source?: { position: IVec; id?: string };
          target?: { position: IVec; id?: string };
        }
      >;
      for (const elem of Object.values(elements)) {
        if (elem.type === "connector") {
          const connectorBound = elem.xywh
            ? Bound.deserialize(elem.xywh)
            : new Bound(0, 0, 0, 0);
          delete elem.xywh;

          for (const endKey of ["source", "target"] as const) {
            const endpoint = elem[endKey];
            if (endpoint && !endpoint.id) {
              const [px, py] = endpoint.position;
              elem[endKey] = {
                position: resetOrigin
                  ? [
                      px - connectorBound.x + targetPoint.x,
                      py - connectorBound.y + targetPoint.y,
                    ]
                  : [px + dx, py + dy],
              };
            }
          }
        }

        if (elem.xywh) {
          const bound = Bound.deserialize(elem.xywh);
          if (resetOrigin) {
            bound.x = targetPoint.x;
            bound.y = targetPoint.y;
            elem.xywh = bound.serialize();
          } else {
            elem.xywh = bound.moveDelta(dx, dy).serialize();
          }
        }
      }
      for (const child of block.children ?? []) rewrite(child);
      return;
    }

    const schema = std.store.schema.get(block.flavour);
    const isGfxBlock =
      schema?.model.toModel?.() instanceof GfxBlockElementModel;
    if (!isGfxBlock) return;

    if (!block.props.xywh) {
      block.props.xywh =
        schema?.model.props?.(internalPrimitives).xywh ?? "[0,0,100,100]";
    }
    const bound =
      Bound.deserialize(block.props.xywh as SerializedXYWH) ??
      new Bound(0, 0, 0, 0);

    if (block.flavour === "myoxus:embed-iframe") {
      let width = EMBED_IFRAME_DEFAULT_WIDTH_IN_SURFACE;
      let height = EMBED_IFRAME_DEFAULT_HEIGHT_IN_SURFACE;
      if (typeof block.props.url === "string") {
        const iframeOpts = std
          .getOptional(EmbedIframeService)
          ?.getConfig(block.props.url)?.options;
        if (iframeOpts) {
          width = iframeOpts.widthInSurface;
          height = iframeOpts.heightInSurface;
        }
      }
      bound.w = width;
      bound.h = height;
    } else if (
      block.flavour === "myoxus:attachment" ||
      block.flavour === "myoxus:bookmark" ||
      block.flavour.startsWith("myoxus:embed-")
    ) {
      const style = (block.props.style ?? "vertical") as EmbedCardStyle;
      block.props.style = style;
      bound.w = EMBED_CARD_WIDTH[style];
      bound.h = EMBED_CARD_HEIGHT[style];
    } else if (block.flavour === "myoxus:image") {
      const props = block.props as { width?: number; height?: number };
      bound.w = bound.w || props.width || 100;
      bound.h = bound.h || props.height || 100;
    }

    if (resetOrigin) {
      bound.x = targetPoint.x;
      bound.y = targetPoint.y;
      block.props.xywh = bound.serialize();
    } else {
      block.props.xywh = bound.moveDelta(dx, dy).serialize();
    }
  };

  for (const root of snapshot.content) rewrite(root);
}
