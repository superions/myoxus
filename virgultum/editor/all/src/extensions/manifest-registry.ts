// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Full store/view manifest registry. Store-only consumers use `./store` so
 * workspace initialization does not enter the full view/widget registry.
 * Store order belongs to that projection; view order remains independent.
 * The consistency contract pins both provider identities and ordering.
 */

import { AnnotationViewExtension } from "@virgultum/content/view";
import { AttachmentViewExtension } from "@virgultum/embeds/view";
import { BookmarkViewExtension } from "@virgultum/embeds/view";
import { BpmnViewExtension } from "@virgultum/block-bpmn/view";
import { CalloutViewExtension } from "@virgultum/content/view";
import { CodeBlockViewExtension } from "@virgultum/content/view";
import { DatabaseReferenceViewExtension } from "@virgultum/embeds/view";
import { dividerManifest } from "@virgultum/content/manifests";
import { EdgelessTextViewExtension } from "@virgultum/canvas/view";
import { EmbedViewExtension } from "@virgultum/embeds/view";
import { EmbedDocViewExtension } from "@virgultum/embeds/view";
import {
  documentIndexManifest,
  tableOfContentsManifest,
} from "@virgultum/content/manifests";
import { eventManifest } from "@virgultum/embeds/manifests";
import { FrameViewExtension } from "@virgultum/canvas/view";
import { ImageViewExtension } from "@virgultum/embeds/view";
import { latexManifest } from "@virgultum/content/manifests";
import { ListViewExtension } from "@virgultum/content/view";
import { mermaidManifest } from "@virgultum/block-mermaid/manifest";
import {
  FootnoteDefinitionViewExtension,
  NoteViewExtension,
} from "@virgultum/embeds/view";
import { ParagraphViewExtension } from "@virgultum/content/view";
import { RootViewExtension } from "../blocks/root/view";
import { SurfaceViewExtension } from "@virgultum/canvas-runtime/view";
import { surfaceRefManifest } from "@virgultum/canvas/manifest";
import { TableViewExtension } from "@virgultum/content/view";
import {
  type ExtensionProviderClass,
  type FeatureManifestId,
  featureManifestId,
} from "@virgultum/core/extensions";
import { FoundationViewExtension } from "../foundation/view";
import { DocTitleViewExtension } from "@virgultum/content/view";
import { FramePanelViewExtension } from "../fragments/frame-panel/view";
import { OutlineViewExtension } from "../fragments/outline/view";
import { BrushViewExtension } from "@virgultum/canvas/view";
import { ConnectorViewExtension } from "@virgultum/canvas/view";
import { GroupViewExtension } from "@virgultum/canvas/view";
import { LinkViewExtension as GfxLinkViewExtension } from "@virgultum/canvas/view";
import { NoteViewExtension as GfxNoteViewExtension } from "@virgultum/canvas/view";
import { PointerViewExtension } from "@virgultum/canvas/view";
import { ShapeViewExtension } from "@virgultum/canvas/view";
import { TemplateViewExtension } from "@virgultum/canvas/view";
import { TextViewExtension } from "@virgultum/canvas/view";
import { InlineCommentViewExtension } from "@virgultum/content/view";
import { FootnoteViewExtension } from "@virgultum/content/view";
import { InlineLatexViewExtension } from "@virgultum/content/view";
import { LinkViewExtension } from "@virgultum/content/view";
import { MentionViewExtension } from "@virgultum/content/view";
import { InlinePresetViewExtension } from "@virgultum/content/view";
import { ReferenceViewExtension } from "@virgultum/content/view";
import { DragHandleViewExtension } from "../widgets/drag-handle/view";
import { EdgelessSelectedRectViewExtension } from "@virgultum/canvas/view";
import { FrameTitleViewExtension } from "@virgultum/canvas/view";
import { LinkedDocViewExtension } from "../widgets/linked-doc/view";
import { RemoteSelectionViewExtension } from "../widgets/remote-selection/view";
import { ScrollAnchoringViewExtension } from "../widgets/scroll-anchoring/view";
import { SlashMenuViewExtension } from "../widgets/slash-menu/view";
import { ToolbarViewExtension } from "../widgets/toolbar/view";
import { ViewportOverlayViewExtension } from "../widgets/viewport-overlay/view";
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
  documentIndexManifest,
  tableOfContentsManifest,
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
    id: featureManifestId("widget-frame-title"),
    view: [FrameTitleViewExtension],
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
    id: featureManifestId("widget-edgeless-selected-rect"),
    view: [EdgelessSelectedRectViewExtension],
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
  featureManifestId("document-index"),
  featureManifestId("table-of-contents"),
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
  featureManifestId("widget-frame-title"),
  featureManifestId("widget-linked-doc"),
  featureManifestId("widget-remote-selection"),
  featureManifestId("widget-scroll-anchoring"),
  featureManifestId("widget-slash-menu"),
  featureManifestId("widget-toolbar"),
  featureManifestId("widget-viewport-overlay"),
  featureManifestId("widget-edgeless-selected-rect"),
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
