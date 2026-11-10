// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Full store/view manifest registry. Store-only consumers use `./store` so
 * workspace initialization does not enter the full view/widget registry.
 * Store order belongs to that projection; view order remains independent.
 * The consistency contract pins both provider identities and ordering.
 */

import { AnnotationViewExtension } from "@virgultum/block-annotation/view";
import { AttachmentViewExtension } from "@virgultum/block-attachment/view";
import { BookmarkViewExtension } from "@virgultum/block-bookmark/view";
import { BpmnViewExtension } from "@virgultum/block-bpmn/view";
import { CalloutViewExtension } from "@virgultum/block-callout/view";
import { CodeBlockViewExtension } from "@virgultum/block-code/view";
import { DatabaseReferenceViewExtension } from "@virgultum/block-database/reference-view";
import { dividerManifest } from "@virgultum/block-divider/manifest";
import { EdgelessTextViewExtension } from "@virgultum/block-edgeless-text/view";
import { EmbedViewExtension } from "@virgultum/block-embed/view";
import { EmbedDocViewExtension } from "@virgultum/block-embed-doc/view";
import { eventManifest } from "@virgultum/block-event/manifest";
import { FrameViewExtension } from "@virgultum/block-frame/view";
import { ImageViewExtension } from "@virgultum/block-image/view";
import { latexManifest } from "@virgultum/block-latex/manifest";
import { ListViewExtension } from "@virgultum/block-list/view";
import { mermaidManifest } from "@virgultum/block-mermaid/manifest";
import {
  FootnoteDefinitionViewExtension,
  NoteViewExtension,
} from "@virgultum/block-note/view";
import { ParagraphViewExtension } from "@virgultum/block-paragraph/view";
import { RootViewExtension } from "@virgultum/block-root/view";
import { SurfaceViewExtension } from "@virgultum/block-surface/view";
import { surfaceRefManifest } from "@virgultum/block-surface-ref/manifest";
import { TableViewExtension } from "@virgultum/block-table/view";
import {
  type ExtensionProviderClass,
  type FeatureManifestId,
  featureManifestId,
} from "@virgultum/ext-loader";
import { FoundationViewExtension } from "@virgultum/foundation/view";
import { DocTitleViewExtension } from "@virgultum/fragment-doc-title/view";
import { FramePanelViewExtension } from "@virgultum/fragment-frame-panel/view";
import { OutlineViewExtension } from "@virgultum/fragment-outline/view";
import { BrushViewExtension } from "@virgultum/gfx-brush/view";
import { ConnectorViewExtension } from "@virgultum/gfx-connector/view";
import { GroupViewExtension } from "@virgultum/gfx-group/view";
import { LinkViewExtension as GfxLinkViewExtension } from "@virgultum/gfx-link/view";
import { NoteViewExtension as GfxNoteViewExtension } from "@virgultum/gfx-note/view";
import { PointerViewExtension } from "@virgultum/gfx-pointer/view";
import { ShapeViewExtension } from "@virgultum/gfx-shape/view";
import { TemplateViewExtension } from "@virgultum/gfx-template/view";
import { TextViewExtension } from "@virgultum/gfx-text/view";
import { InlineCommentViewExtension } from "@virgultum/inline-comment/view";
import { FootnoteViewExtension } from "@virgultum/inline-footnote/view";
import { LatexViewExtension as InlineLatexViewExtension } from "@virgultum/inline-latex/view";
import { LinkViewExtension } from "@virgultum/inline-link/view";
import { MentionViewExtension } from "@virgultum/inline-mention/view";
import { InlinePresetViewExtension } from "@virgultum/inline-preset/view";
import { ReferenceViewExtension } from "@virgultum/inline-reference/view";
import { DragHandleViewExtension } from "@virgultum/widget-drag-handle/view";
import { EdgelessAutoConnectViewExtension } from "@virgultum/widget-edgeless-auto-connect/view";
import { EdgelessDraggingAreaViewExtension } from "@virgultum/widget-edgeless-dragging-area/view";
import { EdgelessSelectedRectViewExtension } from "@virgultum/widget-edgeless-selected-rect/view";
import { EdgelessToolbarViewExtension } from "@virgultum/widget-edgeless-toolbar/view";
import { EdgelessZoomToolbarViewExtension } from "@virgultum/widget-edgeless-zoom-toolbar/view";
import { FrameTitleViewExtension } from "@virgultum/widget-frame-title/view";
import { KeyboardToolbarViewExtension } from "@virgultum/widget-keyboard-toolbar/view";
import { LinkedDocViewExtension } from "@virgultum/widget-linked-doc/view";
import { NoteSlicerViewExtension } from "@virgultum/widget-note-slicer/view";
import { PageDraggingAreaViewExtension } from "@virgultum/widget-page-dragging-area/view";
import { RemoteSelectionViewExtension } from "@virgultum/widget-remote-selection/view";
import { ScrollAnchoringViewExtension } from "@virgultum/widget-scroll-anchoring/view";
import { SlashMenuViewExtension } from "@virgultum/widget-slash-menu/view";
import { ToolbarViewExtension } from "@virgultum/widget-toolbar/view";
import { ViewportOverlayViewExtension } from "@virgultum/widget-viewport-overlay/view";
import { internalStoreExtensionsByFeature } from "./store";
export { getInternalStoreExtensions } from "./store";
import {
  assertRegistryInvariants,
  createFeatureManifestRegistry,
  type FeatureManifest,
  type FeatureManifestRegistry,
} from "./manifest";

/**
 * The list of `FeatureManifest` objects the editor
 * aggregate exposes. Each entry currently declares only
 * the `id`, `store`, and `view` slots; C-02 ff fill in
 * `scopes`, `featureFlag`, `hostServices`,
 * `publicExports`, and `testTags`.
 *
 * The order of the array is a declaration of which
 * features exist; it does NOT drive the order of the
 * resulting extension arrays (see `internalStoreExtensionsByFeature` /
 * `INTERNAL_VIEW_ORDER`).
 */
const INTERNAL_MANIFESTS: ReadonlyArray<FeatureManifest> = [
  {
    id: featureManifestId("annotation"),
    view: [AnnotationViewExtension],
  },
  {
    id: featureManifestId("foundation"),
    view: [FoundationViewExtension],
  },
  {
    id: featureManifestId("attachment"),
    view: [AttachmentViewExtension],
  },
  {
    id: featureManifestId("bpmn"),
    view: [BpmnViewExtension],
  },
  mermaidManifest,
  {
    id: featureManifestId("bookmark"),
    view: [BookmarkViewExtension],
  },
  {
    id: featureManifestId("callout"),
    view: [CalloutViewExtension],
  },
  {
    id: featureManifestId("code"),
    view: [CodeBlockViewExtension],
  },
  {
    id: featureManifestId("database"),
    view: [DatabaseReferenceViewExtension],
  },
  dividerManifest,
  eventManifest,
  {
    id: featureManifestId("edgeless-text"),
    view: [EdgelessTextViewExtension],
  },
  {
    id: featureManifestId("embed"),
    view: [EmbedViewExtension],
  },
  {
    id: featureManifestId("embed-doc"),
    view: [EmbedDocViewExtension],
  },
  {
    id: featureManifestId("frame"),
    view: [FrameViewExtension],
  },
  {
    id: featureManifestId("image"),
    view: [ImageViewExtension],
  },
  latexManifest,
  {
    id: featureManifestId("list"),
    view: [ListViewExtension],
  },
  {
    id: featureManifestId("note"),
    view: [NoteViewExtension],
  },
  {
    id: featureManifestId("footnote-definition"),
    view: [FootnoteDefinitionViewExtension],
  },
  {
    id: featureManifestId("paragraph"),
    view: [ParagraphViewExtension],
  },
  surfaceRefManifest,
  {
    id: featureManifestId("table"),
    view: [TableViewExtension],
  },
  {
    id: featureManifestId("surface"),
    view: [SurfaceViewExtension],
  },
  {
    id: featureManifestId("root"),
    view: [RootViewExtension],
  },
  {
    id: featureManifestId("inline-footnote"),
    view: [FootnoteViewExtension],
  },
  {
    id: featureManifestId("inline-link"),
    view: [LinkViewExtension],
  },
  {
    id: featureManifestId("inline-reference"),
    view: [ReferenceViewExtension],
  },
  {
    id: featureManifestId("inline-latex"),
    view: [InlineLatexViewExtension],
  },
  {
    id: featureManifestId("inline-preset"),
    view: [InlinePresetViewExtension],
  },
  {
    id: featureManifestId("inline-mention"),
    view: [MentionViewExtension],
  },
  {
    id: featureManifestId("inline-comment"),
    view: [InlineCommentViewExtension],
  },
  {
    id: featureManifestId("gfx-brush"),
    view: [BrushViewExtension],
  },
  {
    id: featureManifestId("gfx-shape"),
    view: [ShapeViewExtension],
  },
  {
    id: featureManifestId("gfx-connector"),
    view: [ConnectorViewExtension],
  },
  {
    id: featureManifestId("gfx-group"),
    view: [GroupViewExtension],
  },
  {
    id: featureManifestId("gfx-text"),
    view: [TextViewExtension],
  },
  {
    id: featureManifestId("gfx-pointer"),
    view: [PointerViewExtension],
  },
  {
    id: featureManifestId("gfx-note"),
    view: [GfxNoteViewExtension],
  },
  {
    id: featureManifestId("gfx-template"),
    view: [TemplateViewExtension],
  },
  {
    id: featureManifestId("gfx-link"),
    view: [GfxLinkViewExtension],
  },
  {
    id: featureManifestId("widget-drag-handle"),
    view: [DragHandleViewExtension],
  },
  {
    id: featureManifestId("widget-edgeless-auto-connect"),
    view: [EdgelessAutoConnectViewExtension],
  },
  {
    id: featureManifestId("widget-frame-title"),
    view: [FrameTitleViewExtension],
  },
  {
    id: featureManifestId("widget-keyboard-toolbar"),
    view: [KeyboardToolbarViewExtension],
  },
  {
    id: featureManifestId("widget-linked-doc"),
    view: [LinkedDocViewExtension],
  },
  {
    id: featureManifestId("widget-remote-selection"),
    view: [RemoteSelectionViewExtension],
  },
  {
    id: featureManifestId("widget-scroll-anchoring"),
    view: [ScrollAnchoringViewExtension],
  },
  {
    id: featureManifestId("widget-slash-menu"),
    view: [SlashMenuViewExtension],
  },
  {
    id: featureManifestId("widget-toolbar"),
    view: [ToolbarViewExtension],
  },
  {
    id: featureManifestId("widget-viewport-overlay"),
    view: [ViewportOverlayViewExtension],
  },
  {
    id: featureManifestId("widget-zoom-toolbar"),
    view: [EdgelessZoomToolbarViewExtension],
  },
  {
    id: featureManifestId("widget-page-dragging-area"),
    view: [PageDraggingAreaViewExtension],
  },
  {
    id: featureManifestId("widget-edgeless-selected-rect"),
    view: [EdgelessSelectedRectViewExtension],
  },
  {
    id: featureManifestId("widget-edgeless-dragging-area"),
    view: [EdgelessDraggingAreaViewExtension],
  },
  {
    id: featureManifestId("widget-note-slicer"),
    view: [NoteSlicerViewExtension],
  },
  {
    id: featureManifestId("widget-edgeless-toolbar"),
    view: [EdgelessToolbarViewExtension],
  },
  {
    id: featureManifestId("fragment-doc-title"),
    view: [DocTitleViewExtension],
  },
  {
    id: featureManifestId("fragment-frame-panel"),
    view: [FramePanelViewExtension],
  },
  {
    id: featureManifestId("fragment-outline"),
    view: [OutlineViewExtension],
  },
].map((manifest): FeatureManifest => {
  const store = internalStoreExtensionsByFeature.get(manifest.id);
  return store ? { ...manifest, store: [store] } : manifest;
});

/**
 * Order of `getInternalViewExtensions()`. Each id maps to
 * a manifest that contributes exactly one view extension
 * (the legacy file emits one `*ViewExtension` per feature,
 * ordered: Foundation, Gfx (Pointer..GfxLink), Block
 * (Attachment..Root), Inline, Widget, Fragment).
 */
const INTERNAL_VIEW_ORDER: ReadonlyArray<FeatureManifestId> = [
  featureManifestId("foundation"),
  // Gfx (legacy order)
  featureManifestId("gfx-pointer"),
  featureManifestId("gfx-note"),
  featureManifestId("gfx-brush"),
  featureManifestId("gfx-shape"),
  featureManifestId("gfx-connector"),
  featureManifestId("gfx-group"),
  featureManifestId("gfx-text"),
  featureManifestId("gfx-template"),
  featureManifestId("gfx-link"),
  // Block
  featureManifestId("annotation"),
  featureManifestId("attachment"),
  featureManifestId("bpmn"),
  featureManifestId("mermaid"),
  featureManifestId("bookmark"),
  featureManifestId("callout"),
  featureManifestId("code"),
  featureManifestId("database"),
  featureManifestId("divider"),
  featureManifestId("edgeless-text"),
  featureManifestId("embed"),
  featureManifestId("embed-doc"),
  featureManifestId("event"),
  featureManifestId("frame"),
  featureManifestId("image"),
  featureManifestId("latex"),
  featureManifestId("list"),
  featureManifestId("note"),
  featureManifestId("footnote-definition"),
  featureManifestId("paragraph"),
  featureManifestId("surface-ref"),
  featureManifestId("table"),
  featureManifestId("surface"),
  featureManifestId("root"),
  // Inline (legacy order)
  featureManifestId("inline-comment"),
  featureManifestId("inline-footnote"),
  featureManifestId("inline-link"),
  featureManifestId("inline-reference"),
  featureManifestId("inline-latex"),
  featureManifestId("inline-mention"),
  featureManifestId("inline-preset"),
  // Widget
  featureManifestId("widget-drag-handle"),
  featureManifestId("widget-edgeless-auto-connect"),
  featureManifestId("widget-frame-title"),
  featureManifestId("widget-keyboard-toolbar"),
  featureManifestId("widget-linked-doc"),
  featureManifestId("widget-remote-selection"),
  featureManifestId("widget-scroll-anchoring"),
  featureManifestId("widget-slash-menu"),
  featureManifestId("widget-toolbar"),
  featureManifestId("widget-viewport-overlay"),
  featureManifestId("widget-zoom-toolbar"),
  featureManifestId("widget-page-dragging-area"),
  featureManifestId("widget-edgeless-selected-rect"),
  featureManifestId("widget-edgeless-dragging-area"),
  featureManifestId("widget-note-slicer"),
  featureManifestId("widget-edgeless-toolbar"),
  // Fragment
  featureManifestId("fragment-doc-title"),
  featureManifestId("fragment-frame-panel"),
  featureManifestId("fragment-outline"),
];

/**
 * The internal feature manifest registry. Constructed at
 * module load time. Throws `FeatureManifestRegistryError`
 * if a manifest invariant is violated (duplicate id, empty
 * id).
 */
const REGISTRY: FeatureManifestRegistry =
  createFeatureManifestRegistry(INTERNAL_MANIFESTS);
assertRegistryInvariants(REGISTRY);

/**
 * The internal feature manifest registry, exposed for
 * Phase C-04's scope report and for the
 * `manifest-consistency.unit.spec.ts` test.
 */
export const internalManifestRegistry: FeatureManifestRegistry = REGISTRY;

/**
 * Convenience accessor for the legacy view-extension
 * array. Returns the same array `getInternalViewExtensions()`
 * produced. **Kept for backwards compatibility** with the
 * existing `editor/all`-internal callers and the Myoxus
 * `ViewExtensionManager`
 * (`client/libs/core/src/editor/manager/view.ts`).
 */
export function getInternalViewExtensions(): ExtensionProviderClass[] {
  const out: ExtensionProviderClass[] = [];
  for (const id of INTERNAL_VIEW_ORDER) {
    const m = REGISTRY.byId.get(id);
    if (!m || !m.view || m.view.length === 0) continue;
    out.push(m.view[0]);
  }
  return out;
}
