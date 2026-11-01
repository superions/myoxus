// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Consistency tests for `P-VIRG-ARCH-C-01` (Feature Manifest
 * type and registry).
 *
 * These tests pin the expected registration order: the
 * store-extension and view-extension arrays produced by
 * `getInternalStoreExtensions()` /
 * `getInternalViewExtensions()` (now backed by the
 * `internalManifestRegistry`) must be byte-for-byte equal
 * to the established lists plus explicitly added native capabilities.
 *
 * The legacy lists are recorded inline as `LEGACY_*`
 * constants. If a future refactor drifts the order or the
 * identity of an extension, this test turns red and the
 * Phase-C-04 ViewManager integration would lose track of
 * which features it should be wiring. The closeout of C-01
 * depends on this test passing on the C-01 entry-point.
 *
 * The duplicate-id rejection is also tested, since a
 * regression there would silently produce a broken
 * registry.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-01)
 */

import { AnnotationStoreExtension } from "@virgultum/block-annotation/store";
import { AnnotationViewExtension } from "@virgultum/block-annotation/view";
import { AttachmentStoreExtension } from "@virgultum/block-attachment/store";
import { AttachmentViewExtension } from "@virgultum/block-attachment/view";
import { BookmarkStoreExtension } from "@virgultum/block-bookmark/store";
import { BookmarkViewExtension } from "@virgultum/block-bookmark/view";
import { BpmnStoreExtension } from "@virgultum/block-bpmn/store";
import { BpmnViewExtension } from "@virgultum/block-bpmn/view";
import { CalloutStoreExtension } from "@virgultum/block-callout/store";
import { CalloutViewExtension } from "@virgultum/block-callout/view";
import { CodeStoreExtension } from "@virgultum/block-code/store";
import { CodeBlockViewExtension } from "@virgultum/block-code/view";
import { DataViewStoreExtension } from "@virgultum/block-data-view/store";
import { DataViewViewExtension } from "@virgultum/block-data-view/view";
import { DatabaseReferenceStoreExtension } from "@virgultum/block-database/reference-store";
import { DatabaseReferenceViewExtension } from "@virgultum/block-database/reference-view";
import { DividerStoreExtension } from "@virgultum/block-divider/store";
import { DividerViewExtension } from "@virgultum/block-divider/view";
import { EdgelessTextStoreExtension } from "@virgultum/block-edgeless-text/store";
import { EdgelessTextViewExtension } from "@virgultum/block-edgeless-text/view";
import { EmbedStoreExtension } from "@virgultum/block-embed/store";
import { EmbedViewExtension } from "@virgultum/block-embed/view";
import { EmbedDocStoreExtension } from "@virgultum/block-embed-doc/store";
import { EmbedDocViewExtension } from "@virgultum/block-embed-doc/view";
import { EventStoreExtension } from "@virgultum/block-event/store";
import { EventViewExtension } from "@virgultum/block-event/view";
import { FrameStoreExtension } from "@virgultum/block-frame/store";
import { FrameViewExtension } from "@virgultum/block-frame/view";
import { ImageStoreExtension } from "@virgultum/block-image/store";
import { ImageViewExtension } from "@virgultum/block-image/view";
import { LatexStoreExtension } from "@virgultum/block-latex/store";
import { LatexViewExtension } from "@virgultum/block-latex/view";
import { ListStoreExtension } from "@virgultum/block-list/store";
import { ListViewExtension } from "@virgultum/block-list/view";
import { MermaidStoreExtension } from "@virgultum/block-mermaid/store";
import { MermaidViewExtension } from "@virgultum/block-mermaid/view";
import {
  FootnoteDefinitionStoreExtension,
  NoteStoreExtension,
} from "@virgultum/block-note/store";
import {
  FootnoteDefinitionViewExtension,
  NoteViewExtension,
} from "@virgultum/block-note/view";
import { ParagraphStoreExtension } from "@virgultum/block-paragraph/store";
import { ParagraphViewExtension } from "@virgultum/block-paragraph/view";
import { RootStoreExtension } from "@virgultum/block-root/store";
import { RootViewExtension } from "@virgultum/block-root/view";
import { SurfaceStoreExtension } from "@virgultum/block-surface/store";
import { SurfaceViewExtension } from "@virgultum/block-surface/view";
import { SurfaceRefStoreExtension } from "@virgultum/block-surface-ref/store";
import { SurfaceRefViewExtension } from "@virgultum/block-surface-ref/view";
import { TableStoreExtension } from "@virgultum/block-table/store";
import { TableViewExtension } from "@virgultum/block-table/view";
import { FoundationStoreExtension } from "@virgultum/foundation/store";
import { FoundationViewExtension } from "@virgultum/foundation/view";
import { DocTitleViewExtension } from "@virgultum/fragment-doc-title/view";
import { FramePanelViewExtension } from "@virgultum/fragment-frame-panel/view";
import { OutlineViewExtension } from "@virgultum/fragment-outline/view";
import { BrushStoreExtension } from "@virgultum/gfx-brush/store";
import { BrushViewExtension } from "@virgultum/gfx-brush/view";
import { ConnectorStoreExtension } from "@virgultum/gfx-connector/store";
import { ConnectorViewExtension } from "@virgultum/gfx-connector/view";
import { GroupStoreExtension } from "@virgultum/gfx-group/store";
import { GroupViewExtension } from "@virgultum/gfx-group/view";
import { LinkViewExtension as GfxLinkViewExtension } from "@virgultum/gfx-link/view";
import { NoteViewExtension as GfxNoteViewExtension } from "@virgultum/gfx-note/view";
import { PointerViewExtension } from "@virgultum/gfx-pointer/view";
import { ShapeStoreExtension } from "@virgultum/gfx-shape/store";
import { ShapeViewExtension } from "@virgultum/gfx-shape/view";
import { TemplateViewExtension } from "@virgultum/gfx-template/view";
import { TextStoreExtension } from "@virgultum/gfx-text/store";
import { TextViewExtension } from "@virgultum/gfx-text/view";
import { InlineCommentViewExtension } from "@virgultum/inline-comment/view";
import { FootnoteStoreExtension } from "@virgultum/inline-footnote/store";
import { FootnoteViewExtension } from "@virgultum/inline-footnote/view";
import { LatexStoreExtension as InlineLatexStoreExtension } from "@virgultum/inline-latex/store";
import { LatexViewExtension as InlineLatexViewExtension } from "@virgultum/inline-latex/view";
import { LinkStoreExtension } from "@virgultum/inline-link/store";
import { LinkViewExtension } from "@virgultum/inline-link/view";
import { MentionViewExtension } from "@virgultum/inline-mention/view";
import { InlinePresetStoreExtension } from "@virgultum/inline-preset/store";
import { InlinePresetViewExtension } from "@virgultum/inline-preset/view";
import { ReferenceStoreExtension } from "@virgultum/inline-reference/store";
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
import { describe, expect, test } from "vitest";

import {
  assertRegistryInvariants,
  checkRegistryInvariants,
  createFeatureManifestRegistry,
  type FeatureManifest,
  featureManifestId,
} from "../manifest";
import {
  getInternalStoreExtensions,
  getInternalViewExtensions,
  internalManifestRegistry,
} from "../manifest-registry";

const LEGACY_STORE = [
  FoundationStoreExtension,
  AnnotationStoreExtension,
  AttachmentStoreExtension,
  BpmnStoreExtension,
  MermaidStoreExtension,
  BookmarkStoreExtension,
  CalloutStoreExtension,
  CodeStoreExtension,
  DataViewStoreExtension,
  DatabaseReferenceStoreExtension,
  DividerStoreExtension,
  EventStoreExtension,
  EdgelessTextStoreExtension,
  EmbedStoreExtension,
  EmbedDocStoreExtension,
  FrameStoreExtension,
  ImageStoreExtension,
  LatexStoreExtension,
  ListStoreExtension,
  NoteStoreExtension,
  FootnoteDefinitionStoreExtension,
  ParagraphStoreExtension,
  SurfaceRefStoreExtension,
  TableStoreExtension,
  SurfaceStoreExtension,
  RootStoreExtension,
  FootnoteStoreExtension,
  LinkStoreExtension,
  ReferenceStoreExtension,
  InlineLatexStoreExtension,
  InlinePresetStoreExtension,
  BrushStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
  GroupStoreExtension,
  TextStoreExtension,
];

const LEGACY_VIEW = [
  FoundationViewExtension,
  PointerViewExtension,
  GfxNoteViewExtension,
  BrushViewExtension,
  ShapeViewExtension,
  ConnectorViewExtension,
  GroupViewExtension,
  TextViewExtension,
  TemplateViewExtension,
  GfxLinkViewExtension,
  AnnotationViewExtension,
  AttachmentViewExtension,
  BpmnViewExtension,
  MermaidViewExtension,
  BookmarkViewExtension,
  CalloutViewExtension,
  CodeBlockViewExtension,
  DataViewViewExtension,
  DatabaseReferenceViewExtension,
  DividerViewExtension,
  EdgelessTextViewExtension,
  EmbedViewExtension,
  EmbedDocViewExtension,
  EventViewExtension,
  FrameViewExtension,
  ImageViewExtension,
  LatexViewExtension,
  ListViewExtension,
  NoteViewExtension,
  FootnoteDefinitionViewExtension,
  ParagraphViewExtension,
  SurfaceRefViewExtension,
  TableViewExtension,
  SurfaceViewExtension,
  RootViewExtension,
  InlineCommentViewExtension,
  FootnoteViewExtension,
  LinkViewExtension,
  ReferenceViewExtension,
  InlineLatexViewExtension,
  MentionViewExtension,
  InlinePresetViewExtension,
  DragHandleViewExtension,
  EdgelessAutoConnectViewExtension,
  FrameTitleViewExtension,
  KeyboardToolbarViewExtension,
  LinkedDocViewExtension,
  RemoteSelectionViewExtension,
  ScrollAnchoringViewExtension,
  SlashMenuViewExtension,
  ToolbarViewExtension,
  ViewportOverlayViewExtension,
  EdgelessZoomToolbarViewExtension,
  PageDraggingAreaViewExtension,
  EdgelessSelectedRectViewExtension,
  EdgelessDraggingAreaViewExtension,
  NoteSlicerViewExtension,
  EdgelessToolbarViewExtension,
  DocTitleViewExtension,
  FramePanelViewExtension,
  OutlineViewExtension,
];

describe("P-VIRG-ARCH-C-01 Feature Manifest", () => {
  describe("registry invariants", () => {
    test("internalManifestRegistry has consistent byId map", () => {
      expect(checkRegistryInvariants(internalManifestRegistry)).toBeNull();
      expect(() =>
        assertRegistryInvariants(internalManifestRegistry),
      ).not.toThrow();
    });

    test("registry rejects duplicate manifest ids", () => {
      const dup: FeatureManifest[] = [
        { id: featureManifestId("dup") },
        { id: featureManifestId("dup") },
      ];
      expect(() => createFeatureManifestRegistry(dup)).toThrow(
        /duplicate manifest id/,
      );
    });

    test("registry rejects empty manifest ids", () => {
      const empty: FeatureManifest[] = [{ id: featureManifestId("") }];
      expect(() => createFeatureManifestRegistry(empty)).toThrow(
        /non-empty string/,
      );
    });

    test("registry accepts an empty list and produces empty arrays", () => {
      const r = createFeatureManifestRegistry([]);
      expect(r.storeExtensions).toEqual([]);
      expect(r.viewExtensions).toEqual([]);
      expect(r.effects).toEqual([]);
      expect(r.byId.size).toBe(0);
    });

    test("registry deduplicates effect ids while preserving first-seen order", () => {
      const r = createFeatureManifestRegistry([
        {
          id: featureManifestId("a"),
          effects: ["x", "y"],
        },
        {
          id: featureManifestId("b"),
          effects: ["y", "z"],
        },
      ]);
      expect(r.effects).toEqual(["x", "y", "z"]);
    });
  });

  describe("backwards compatibility: store and view ordering preserved", () => {
    test("getInternalStoreExtensions() matches the legacy list element-by-element", () => {
      const current = getInternalStoreExtensions();
      expect(current.length).toBe(LEGACY_STORE.length);
      for (let i = 0; i < LEGACY_STORE.length; i++) {
        expect(current[i]).toBe(LEGACY_STORE[i]);
      }
      // Identity check via array equality: toBe uses Object.is,
      // so the same ExtensionType instance must be present.
      expect(current).toEqual(LEGACY_STORE);
    });

    test("getInternalViewExtensions() matches the legacy list element-by-element", () => {
      const current = getInternalViewExtensions();
      expect(current.length).toBe(LEGACY_VIEW.length);
      for (let i = 0; i < LEGACY_VIEW.length; i++) {
        expect(current[i]).toBe(LEGACY_VIEW[i]);
      }
      expect(current).toEqual(LEGACY_VIEW);
    });

    test("registry has at least one manifest per legacy feature id", () => {
      // Sanity: the legacy store order is 36 entries; the
      // registry must have at least 36 manifests that
      // contribute a store extension.
      const storeContributors = internalManifestRegistry.manifests.filter(
        (m) => m.store !== undefined && m.store.length > 0,
      );
      expect(storeContributors.length).toBeGreaterThanOrEqual(
        LEGACY_STORE.length,
      );
      const viewContributors = internalManifestRegistry.manifests.filter(
        (m) => m.view !== undefined && m.view.length > 0,
      );
      expect(viewContributors.length).toBeGreaterThanOrEqual(
        LEGACY_VIEW.length,
      );
    });
  });
});
