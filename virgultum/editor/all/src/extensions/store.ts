// SPDX-License-Identifier: MIT

import { AnnotationStoreExtension } from "@virgultum/content/store";
import { AttachmentStoreExtension } from "@virgultum/embeds/store";
import { BookmarkStoreExtension } from "@virgultum/embeds/store";
import { BpmnStoreExtension } from "@virgultum/block-bpmn/store";
import { CalloutStoreExtension } from "@virgultum/content/store";
import { CodeStoreExtension } from "@virgultum/content/store";
import { DatabaseReferenceStoreExtension } from "@virgultum/embeds/data";
import { DividerStoreExtension } from "@virgultum/content/store";
import { EdgelessTextStoreExtension } from "@virgultum/canvas/store";
import { EmbedStoreExtension } from "@virgultum/embeds/store";
import { EmbedDocStoreExtension } from "@virgultum/embeds/store";
import { DocumentIndexStoreExtension } from "@virgultum/content/store";
import { TableOfContentsStoreExtension } from "@virgultum/content/store";
import { EventStoreExtension } from "@virgultum/embeds/store";
import { FrameStoreExtension } from "@virgultum/canvas/store";
import { ImageStoreExtension } from "@virgultum/embeds/store";
import { BlockLatexStoreExtension as LatexStoreExtension } from "@virgultum/content/store";
import { ListStoreExtension } from "@virgultum/content/store";
import { MermaidStoreExtension } from "@virgultum/block-mermaid/store";
import {
  FootnoteDefinitionStoreExtension,
  NoteStoreExtension,
} from "@virgultum/embeds/store";
import { ParagraphStoreExtension } from "@virgultum/content/store";
import { RootStoreExtension } from "../blocks/root/store";
import { SurfaceStoreExtension } from "@virgultum/canvas-runtime/store";
import { SurfaceRefStoreExtension } from "@virgultum/canvas/store";
import { TableStoreExtension } from "@virgultum/content/store";
import { FoundationStoreExtension } from "../foundation/store";
import { BrushStoreExtension } from "@virgultum/canvas/store";
import { ConnectorStoreExtension } from "@virgultum/canvas/store";
import { GroupStoreExtension } from "@virgultum/canvas/store";
import { ShapeStoreExtension } from "@virgultum/canvas/store";
import { TextStoreExtension } from "@virgultum/canvas/store";
import { FootnoteStoreExtension } from "@virgultum/content/store";
import { InlineLatexStoreExtension } from "@virgultum/content/store";
import { LinkStoreExtension } from "@virgultum/content/store";
import { InlinePresetStoreExtension } from "@virgultum/content/store";
import { ReferenceStoreExtension } from "@virgultum/content/store";
import {
  type ExtensionProviderClass,
  type FeatureManifestId,
  featureManifestId,
} from "@virgultum/core/extensions";

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
  [featureManifestId("database"), DatabaseReferenceStoreExtension],
  [featureManifestId("divider"), DividerStoreExtension],
  [featureManifestId("event"), EventStoreExtension],
  [featureManifestId("document-index"), DocumentIndexStoreExtension],
  [featureManifestId("table-of-contents"), TableOfContentsStoreExtension],
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
