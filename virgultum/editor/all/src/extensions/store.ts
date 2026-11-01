// SPDX-License-Identifier: MIT

import { AnnotationStoreExtension } from "@virgultum/block-annotation/store";
import { AttachmentStoreExtension } from "@virgultum/block-attachment/store";
import { BookmarkStoreExtension } from "@virgultum/block-bookmark/store";
import { BpmnStoreExtension } from "@virgultum/block-bpmn/store";
import { CalloutStoreExtension } from "@virgultum/block-callout/store";
import { CodeStoreExtension } from "@virgultum/block-code/store";
import { DataViewStoreExtension } from "@virgultum/block-data-view/store";
import { DatabaseReferenceStoreExtension } from "@virgultum/block-database/reference-store";
import { DividerStoreExtension } from "@virgultum/block-divider/store";
import { EdgelessTextStoreExtension } from "@virgultum/block-edgeless-text/store";
import { EmbedStoreExtension } from "@virgultum/block-embed/store";
import { EmbedDocStoreExtension } from "@virgultum/block-embed-doc/store";
import { EventStoreExtension } from "@virgultum/block-event/store";
import { FrameStoreExtension } from "@virgultum/block-frame/store";
import { ImageStoreExtension } from "@virgultum/block-image/store";
import { LatexStoreExtension } from "@virgultum/block-latex/store";
import { ListStoreExtension } from "@virgultum/block-list/store";
import { MermaidStoreExtension } from "@virgultum/block-mermaid/store";
import {
  FootnoteDefinitionStoreExtension,
  NoteStoreExtension,
} from "@virgultum/block-note/store";
import { ParagraphStoreExtension } from "@virgultum/block-paragraph/store";
import { RootStoreExtension } from "@virgultum/block-root/store";
import { SurfaceStoreExtension } from "@virgultum/block-surface/store";
import { SurfaceRefStoreExtension } from "@virgultum/block-surface-ref/store";
import { TableStoreExtension } from "@virgultum/block-table/store";
import { FoundationStoreExtension } from "@virgultum/foundation/store";
import { BrushStoreExtension } from "@virgultum/gfx-brush/store";
import { ConnectorStoreExtension } from "@virgultum/gfx-connector/store";
import { GroupStoreExtension } from "@virgultum/gfx-group/store";
import { ShapeStoreExtension } from "@virgultum/gfx-shape/store";
import { TextStoreExtension } from "@virgultum/gfx-text/store";
import { FootnoteStoreExtension } from "@virgultum/inline-footnote/store";
import { LatexStoreExtension as InlineLatexStoreExtension } from "@virgultum/inline-latex/store";
import { LinkStoreExtension } from "@virgultum/inline-link/store";
import { InlinePresetStoreExtension } from "@virgultum/inline-preset/store";
import { ReferenceStoreExtension } from "@virgultum/inline-reference/store";
import {
  type ExtensionProviderClass,
  type FeatureManifestId,
  featureManifestId,
} from "@virgultum/ext-loader";

// Keep the store projection independent of the full view/widget registry.
// The full manifest registry composes these same providers with its view slots.
export const internalStoreExtensionsByFeature: ReadonlyMap<
  FeatureManifestId,
  ExtensionProviderClass
> = new Map<FeatureManifestId, ExtensionProviderClass>([
  [featureManifestId("foundation"), FoundationStoreExtension],
  [featureManifestId("annotation"), AnnotationStoreExtension],
  [featureManifestId("attachment"), AttachmentStoreExtension],
  [featureManifestId("bpmn"), BpmnStoreExtension],
  [featureManifestId("mermaid"), MermaidStoreExtension],
  [featureManifestId("bookmark"), BookmarkStoreExtension],
  [featureManifestId("callout"), CalloutStoreExtension],
  [featureManifestId("code"), CodeStoreExtension],
  [featureManifestId("data-view"), DataViewStoreExtension],
  [featureManifestId("database"), DatabaseReferenceStoreExtension],
  [featureManifestId("divider"), DividerStoreExtension],
  [featureManifestId("event"), EventStoreExtension],
  [featureManifestId("edgeless-text"), EdgelessTextStoreExtension],
  [featureManifestId("embed"), EmbedStoreExtension],
  [featureManifestId("embed-doc"), EmbedDocStoreExtension],
  [featureManifestId("frame"), FrameStoreExtension],
  [featureManifestId("image"), ImageStoreExtension],
  [featureManifestId("latex"), LatexStoreExtension],
  [featureManifestId("list"), ListStoreExtension],
  [featureManifestId("note"), NoteStoreExtension],
  [featureManifestId("footnote-definition"), FootnoteDefinitionStoreExtension],
  [featureManifestId("paragraph"), ParagraphStoreExtension],
  [featureManifestId("surface-ref"), SurfaceRefStoreExtension],
  [featureManifestId("table"), TableStoreExtension],
  [featureManifestId("surface"), SurfaceStoreExtension],
  [featureManifestId("root"), RootStoreExtension],
  [featureManifestId("inline-footnote"), FootnoteStoreExtension],
  [featureManifestId("inline-link"), LinkStoreExtension],
  [featureManifestId("inline-reference"), ReferenceStoreExtension],
  [featureManifestId("inline-latex"), InlineLatexStoreExtension],
  [featureManifestId("inline-preset"), InlinePresetStoreExtension],
  [featureManifestId("gfx-brush"), BrushStoreExtension],
  [featureManifestId("gfx-shape"), ShapeStoreExtension],
  [featureManifestId("gfx-connector"), ConnectorStoreExtension],
  [featureManifestId("gfx-group"), GroupStoreExtension],
  [featureManifestId("gfx-text"), TextStoreExtension],
]);

/** Preserve provider identity and registration order with a fresh result array. */
export function getInternalStoreExtensions(): ExtensionProviderClass[] {
  return [...internalStoreExtensionsByFeature.values()];
}
