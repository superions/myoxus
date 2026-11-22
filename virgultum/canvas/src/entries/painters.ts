// SPDX-License-Identifier: AGPL-3.0-or-later
import { Container } from "@virgultum/core/primitives/di";
import {
  ElementRendererIdentifier,
  type ElementRenderer,
} from "@virgultum/canvas-runtime/surface";
import { ShapeElementRendererExtension } from "../gfx/shape/element-renderer/shape";
import { TextElementRendererExtension } from "../gfx/text/element-renderer";
import { BrushElementRendererExtension } from "../gfx/brush/renderer/element/brush";
import { HighlighterElementRendererExtension } from "../gfx/brush/renderer/element/highlighter";
import { ConnectorElementRendererExtension } from "../gfx/connector/renderer/element-renderer";
import { GroupElementRendererExtension } from "../gfx/group/renderer/element-renderer";

/** Raster-only registry; tool, widget and DOM-view contributions belong to
 * interactive sessions and are not installed in a document preview. */
export function canvasPainters() {
  const registry = new Container();
  for (const extension of [
    ShapeElementRendererExtension,
    TextElementRendererExtension,
    BrushElementRendererExtension,
    HighlighterElementRendererExtension,
    ConnectorElementRendererExtension,
    GroupElementRendererExtension,
  ])
    extension.setup(registry);
  const provider = registry.provider();
  return (type: string) =>
    provider.getOptional<ElementRenderer>(ElementRendererIdentifier(type));
}
