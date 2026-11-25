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

import { AnnotationStoreExtension } from "@virgultum/content/store";
import { AnnotationViewExtension } from "@virgultum/content/view";
import { AttachmentStoreExtension } from "@virgultum/embeds/store";
import { AttachmentViewExtension } from "@virgultum/embeds/view";
import { BookmarkStoreExtension } from "@virgultum/embeds/store";
import { BookmarkViewExtension } from "@virgultum/embeds/view";
import { BpmnStoreExtension } from "@virgultum/block-bpmn/store";
import { BpmnViewExtension } from "@virgultum/block-bpmn/view";
import { CalloutStoreExtension } from "@virgultum/content/store";
import { CalloutViewExtension } from "@virgultum/content/view";
import { CodeStoreExtension } from "@virgultum/content/store";
import { CodeBlockViewExtension } from "@virgultum/content/view";
import { DatabaseReferenceStoreExtension } from "@virgultum/embeds/data";
import { DatabaseReferenceViewExtension } from "@virgultum/embeds/view";
import { DividerStoreExtension } from "@virgultum/content/store";
import { DividerViewExtension } from "@virgultum/content/view";
import { EdgelessTextStoreExtension } from "@virgultum/canvas/store";
import { EdgelessTextViewExtension } from "@virgultum/canvas/view";
import { EmbedStoreExtension } from "@virgultum/embeds/store";
import { EmbedViewExtension } from "@virgultum/embeds/view";
import { EmbedDocStoreExtension } from "@virgultum/embeds/store";
import { EmbedDocViewExtension } from "@virgultum/embeds/view";
import { DocumentIndexStoreExtension } from "@virgultum/content/store";
import { DocumentIndexViewExtension } from "@virgultum/content/view";
import { EventStoreExtension } from "@virgultum/embeds/store";
import { EventViewExtension } from "@virgultum/embeds/view";
import { FrameStoreExtension } from "@virgultum/canvas/store";
import { FrameViewExtension } from "@virgultum/canvas/view";
import { ImageStoreExtension } from "@virgultum/embeds/store";
import { ImageViewExtension } from "@virgultum/embeds/view";
import { BlockLatexStoreExtension as LatexStoreExtension } from "@virgultum/content/store";
import { BlockLatexViewExtension as LatexViewExtension } from "@virgultum/content/view";
import { ListStoreExtension } from "@virgultum/content/store";
import { ListViewExtension } from "@virgultum/content/view";
import { MermaidStoreExtension } from "@virgultum/block-mermaid/store";
import { MermaidViewExtension } from "@virgultum/block-mermaid/view";
import {
  FootnoteDefinitionStoreExtension,
  NoteStoreExtension,
} from "@virgultum/embeds/store";
import {
  FootnoteDefinitionViewExtension,
  NoteViewExtension,
} from "@virgultum/embeds/view";
import { ParagraphStoreExtension } from "@virgultum/content/store";
import { ParagraphViewExtension } from "@virgultum/content/view";
import { RootStoreExtension } from "../../blocks/root/store";
import { RootViewExtension } from "../../blocks/root/view";
import { SurfaceStoreExtension } from "@virgultum/canvas-runtime/store";
import { SurfaceViewExtension } from "@virgultum/canvas-runtime/view";
import { SurfaceRefStoreExtension } from "@virgultum/canvas/store";
import { SurfaceRefViewExtension } from "@virgultum/canvas/view";
import { TableStoreExtension } from "@virgultum/content/store";
import { TableViewExtension } from "@virgultum/content/view";
import { FoundationStoreExtension } from "../../foundation/store";
import { FoundationViewExtension } from "../../foundation/view";
import { DocTitleViewExtension } from "@virgultum/content/view";
import { FramePanelViewExtension } from "../../fragments/frame-panel/view";
import { OutlineViewExtension } from "../../fragments/outline/view";
import { BrushStoreExtension } from "@virgultum/canvas/store";
import { BrushViewExtension } from "@virgultum/canvas/view";
import { ConnectorStoreExtension } from "@virgultum/canvas/store";
import { ConnectorViewExtension } from "@virgultum/canvas/view";
import { GroupStoreExtension } from "@virgultum/canvas/store";
import { GroupViewExtension } from "@virgultum/canvas/view";
import { LinkViewExtension as GfxLinkViewExtension } from "@virgultum/canvas/view";
import { NoteViewExtension as GfxNoteViewExtension } from "@virgultum/canvas/view";
import { PointerViewExtension } from "@virgultum/canvas/view";
import { ShapeStoreExtension } from "@virgultum/canvas/store";
import { ShapeViewExtension } from "@virgultum/canvas/view";
import { TemplateViewExtension } from "@virgultum/canvas/view";
import { TextStoreExtension } from "@virgultum/canvas/store";
import { TextViewExtension } from "@virgultum/canvas/view";
import { InlineCommentViewExtension } from "@virgultum/content/view";
import { FootnoteStoreExtension } from "@virgultum/content/store";
import { FootnoteViewExtension } from "@virgultum/content/view";
import { InlineLatexStoreExtension } from "@virgultum/content/store";
import { InlineLatexViewExtension } from "@virgultum/content/view";
import { LinkStoreExtension } from "@virgultum/content/store";
import { LinkViewExtension } from "@virgultum/content/view";
import { MentionViewExtension } from "@virgultum/content/view";
import { InlinePresetStoreExtension } from "@virgultum/content/store";
import { InlinePresetViewExtension } from "@virgultum/content/view";
import { ReferenceStoreExtension } from "@virgultum/content/store";
import { ReferenceViewExtension } from "@virgultum/content/view";
import { DragHandleViewExtension } from "../../widgets/drag-handle/view";
import { EdgelessAutoConnectViewExtension } from "@virgultum/canvas/view";
import { EdgelessSelectedRectViewExtension } from "@virgultum/canvas/view";
import { EdgelessToolbarViewExtension } from "@virgultum/canvas/view";
import { FrameTitleViewExtension } from "@virgultum/canvas/view";
import { LinkedDocViewExtension } from "../../widgets/linked-doc/view";
import { NoteSlicerViewExtension } from "@virgultum/canvas/view";
import { RemoteSelectionViewExtension } from "../../widgets/remote-selection/view";
import { ScrollAnchoringViewExtension } from "../../widgets/scroll-anchoring/view";
import { SlashMenuViewExtension } from "../../widgets/slash-menu/view";
import { ToolbarViewExtension } from "../../widgets/toolbar/view";
import { ViewportOverlayViewExtension } from "../../widgets/viewport-overlay/view";
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
  DatabaseReferenceStoreExtension,
  DividerStoreExtension,
  EventStoreExtension,
  DocumentIndexStoreExtension,
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
  DatabaseReferenceViewExtension,
  DividerViewExtension,
  EdgelessTextViewExtension,
  EmbedViewExtension,
  EmbedDocViewExtension,
  EventViewExtension,
  DocumentIndexViewExtension,
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
  LinkedDocViewExtension,
  RemoteSelectionViewExtension,
  ScrollAnchoringViewExtension,
  SlashMenuViewExtension,
  ToolbarViewExtension,
  ViewportOverlayViewExtension,
  EdgelessSelectedRectViewExtension,
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
