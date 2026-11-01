// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConnectorPathGenerator } from "@virgultum/gfx-connector";
import { Bound } from "@virgultum/global/gfx";
import {
  LocalShapeElementModel,
  LocalConnectorElementModel,
  ConnectorElementModel,
  ShapeType,
} from "@virgultum/model";
import type { GfxModel } from "@virgultum/std/gfx";
import type { SurfaceBlockModel } from "@virgultum/std/gfx";
import type { MermaidVisualModel } from "./gfx-model.js";
import { getMermaidGfxFamilyHooks } from "./gfx-family-hooks-registry.js";
import { createMermaidElementIndexMaps } from "./gfx-layer-order.js";
import {
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
  toMermaidNodeDetailElementProps,
  toMermaidConnectorElementProps,
  resolveMermaidConnectorLabelXYWH,
  getMermaidVisualNodeDetailElementEntries,
  mermaidGfxEdgeLabelOffset,
} from "./gfx-element-projection.js";

export type MermaidGfxPreviewTarget = {
  surface: SurfaceBlockModel;
  viewport: object;
  creator?: GfxModel;
  origin: Bound;
  elements: readonly {
    hidden: boolean;
    yMap?: { get: (key: string) => unknown };
    stash: (prop: string) => void;
    pop: (prop: string) => void;
  }[];
  refresh: () => void;
  /** Optional renderer-local replacement; otherwise retain existing hidden-property previews. */
  hideOriginals?: () => () => void;
};
export type MermaidGfxPreview = (() => void) & {
  resolveNode?: (key: string) => LocalShapeElementModel | null;
};

/** A candidate uses native local GFX elements on the currently visible Surface.
 * No Source, child map, geometry field, or document history entry is written.
 * The disposer restores the retained presentation when the draft finishes. */
export function previewMermaidGfxModel(
  visual: MermaidVisualModel,
  target: MermaidGfxPreviewTarget,
): MermaidGfxPreview {
  const hooks = getMermaidGfxFamilyHooks(visual);
  if (!hooks) throw new Error("No GFX family for preview");
  // Local models otherwise share a default index and are sorted by random ID.
  // One creator keeps the preview contiguous; the shared layer plan prevents
  // authored backgrounds from covering its participants and messages.
  let nextLayer = 0;
  const nextIndex = () => `a${String(nextLayer++).padStart(8, "0")}`;
  const indexes = createMermaidElementIndexMaps(visual, nextIndex);
  const hidden = target.elements.map((element) => ({
      element,
      hidden: element.hidden,
    })),
    local: Array<LocalShapeElementModel | LocalConnectorElementModel> = [],
    idMap = new Map<string, string>(),
    elements = new Map<string, GfxModel>();
  const shape = (props: Record<string, unknown>, key: string) => {
    const model = new LocalShapeElementModel(target.surface);
    Object.assign(model, props, {
      id: `mermaid-preview-${crypto.randomUUID()}`,
      text: String(props.text ?? ""),
      renderViewport: target.viewport,
      creator: target.creator,
    });
    idMap.set(key, model.id);
    elements.set(model.id, model as unknown as GfxModel);
    local.push(model);
    target.surface.addLocalElement(model);
    return model;
  };
  let restoreOriginals: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const model of local) target.surface.deleteLocalElement(model);
    restoreOriginals?.();
    for (const { element, hidden: initial } of target.hideOriginals
      ? []
      : hidden) {
      element.hidden =
        typeof element.yMap?.get("hidden") === "boolean"
          ? (element.yMap.get("hidden") as boolean)
          : initial;
      element.pop("hidden");
    }
    target.refresh();
  };
  try {
    if (target.hideOriginals) restoreOriginals = target.hideOriginals();
    for (const { element } of target.hideOriginals ? [] : hidden) {
      element.stash("hidden");
      element.hidden = true;
    }
    for (const group of visual.subgraphs ?? [])
      shape(
        {
          ...toMermaidSubgraphElementProps(
            group,
            target.origin,
            hooks.subgraphElementProjection(visual, group),
          ),
          index: indexes.subgraphs.get(group.id),
        },
        group.id,
      );
    for (const node of visual.nodes)
      shape(
        {
          ...toMermaidShapeElementProps(
            node,
            target.origin,
            visual.direction,
            visual.diagramTitle,
            hooks.nodeElementProjection(visual, node),
          ),
          index: indexes.shapes.get(node.id),
        },
        node.id,
      );
    for (const entry of getMermaidVisualNodeDetailElementEntries(visual)) {
      const projection =
        entry.projection ??
        hooks.nodeDetailElementProjection?.(visual, entry.node, entry.detail);
      if (projection)
        shape(
          {
            ...toMermaidNodeDetailElementProps({
              ...entry,
              projection,
              ownerBound: target.origin,
            }),
            index: indexes.details.get(entry.elementId),
          },
          entry.elementId,
        );
    }
    for (const [index, edge] of visual.edges.entries()) {
      const projection = hooks.edgeElementProjection(visual, edge, index),
        label = resolveMermaidConnectorLabelXYWH({
          edge,
          elementProjection: projection,
          ownerBound: target.origin,
          visualModel: visual,
          labelOffset: mermaidGfxEdgeLabelOffset(visual, edge),
        }),
        props = toMermaidConnectorElementProps(edge, idMap, label, projection),
        model = new LocalConnectorElementModel(target.surface);
      Object.assign(model, props, {
        id: `mermaid-preview-${crypto.randomUUID()}`,
        renderViewport: target.viewport,
        creator: target.creator,
        index: indexes.connectors.get(edge.id),
      });
      ConnectorPathGenerator.updatePath(
        model,
        null,
        (id) => elements.get(id) ?? null,
      );
      const placedLabel = label
        ? ConnectorElementModel.prototype.getLabelXYWHOnPath.call(
            {
              labelObstacleIds: props.labelObstacleIds,
              routingObstacleRegions: props.routingObstacleRegions,
              surface: { getElementById: (id: string) => elements.get(id) },
              getPointByOffsetDistance: (distance: number) =>
                ConnectorElementModel.prototype.getPointByOffsetDistance.call(
                  model as never,
                  distance,
                ),
            } as never,
            label[2],
            label[3],
            props.labelOffset,
          )
        : undefined;
      Object.assign(model, { labelXYWH: placedLabel });
      idMap.set(edge.id, model.id);
      elements.set(model.id, model as unknown as GfxModel);
      local.push(model);
      target.surface.addLocalElement(model);
      if (placedLabel && (edge.displayLabel ?? edge.label))
        shape(
          {
            xywh: new Bound(...placedLabel).serialize(),
            text: edge.displayLabel ?? edge.label,
            shapeType: ShapeType.MermaidText,
            filled: false,
            strokeWidth: 0,
            padding: [0, 0],
            index: nextIndex(),
            rotate: 0,
            ...props.labelStyle,
          },
          `${edge.id}:label`,
        );
    }
    target.refresh();
    return Object.assign(dispose, {
      resolveNode: (key: string) => {
        const element = elements.get(idMap.get(key) ?? "");
        return element instanceof LocalShapeElementModel ? element : null;
      },
    });
  } catch (error) {
    dispose();
    throw error;
  }
}
