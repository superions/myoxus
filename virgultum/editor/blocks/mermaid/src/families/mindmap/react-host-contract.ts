// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TemplateResult } from "lit";
import type { ShapeTextEditDraftActions } from "@virgultum/gfx-shape";
import type { MermaidMindmapModel } from "../../engine/mindmap/index.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
import type { MindmapAction } from "./actions.js";
import type { MindmapLayoutType as LayoutType } from "./projection/types.js";
export type MindmapCreateIntent =
  | { type: "add-root" }
  | {
      type: "add-child" | "add-sibling";
      key: string;
      side?: LayoutType.LEFT | LayoutType.RIGHT;
    };
export type MindmapEditIntent =
  | MindmapCreateIntent
  | { type: "layout" }
  | { type: "import" }
  | { type: "rename"; key: string }
  | { type: "duplicate"; keys: readonly string[] }
  | { type: "properties"; key: string }
  | { type: "move"; key: string }
  | { type: "delete"; keys: readonly string[] }
  | { type: "toggle-collapse"; key: string };
export type MindmapReactHostProps = {
  readonly history?: import("../runtime/shell-contract.js").MermaidHistoryActions;
  readonly clipboard?: import("../../clipboard.js").MermaidClipboardPort;
  readonly subscribeEditIntent?: (
    handler: (
      intent: import("../runtime/editor-capabilities.js").MermaidGfxObjectEditIntent,
    ) => void,
  ) => () => void;
  readonly onExportMmd?: () => void;
  readonly importFileSizeLimit: number;
  readonly onImport: (
    candidate: import("./import/foreign.js").PreparedMindmapImport,
    basis: string,
    position?: { x: number; y: number },
  ) => { changed: boolean; diagnostic?: string };
  readonly surface: "editor" | "controls";
  readonly model: MermaidMindmapModel;
  readonly sourceBasis: string;
  readonly selectedKey: string | null;
  readonly selectedKeys: readonly string[];
  readonly projection: import("./projection/layout.js").MindmapProjectionOptions;
  readonly nodeHandles?: readonly import("./interaction/handles.js").MindmapNodeHandlePlan[];
  readonly draftActive?: boolean;
  readonly drag?: import("./interaction/drag.js").MindmapDragPort;
  readonly selectedAnchorSide?: "left" | "right";
  readonly selectedAnchor: { left: number; top: number } | null;
  readonly commentMarkers?: readonly import("./interaction/anchors.js").MindmapCommentMarker[];
  readonly markersInClientSpace?: boolean;
  readonly readonly: boolean;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly actionTarget?: HTMLElement | null;
  readonly workarea: TemplateResult | null;
  readonly workareaFooter: TemplateResult | null;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly intent: MindmapEditIntent | null;
  readonly onIntent: (intent: MindmapEditIntent | null) => void;
  /** Readonly exploration is viewport-local and never enters document history. */
  readonly onPreviewCollapsed: (
    keys: ReadonlySet<string>,
  ) => (() => void) | null;
  readonly onPreview?: (
    action: MindmapAction,
    basis: string,
  ) => (() => void) | null;
  readonly onCommand: (
    action: MindmapAction,
    basis: string,
  ) => {
    changed: boolean;
    diagnostic?: string;
    sourceBasis?: string;
    selection?: string;
  };
  readonly onWorkareaResize: () => void;
  readonly onFitViewport?: () => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
};
export type MindmapPreviewHostProps = {
  readonly surface: "preview";
  readonly host: import("@virgultum/std").EditorHost;
  readonly model: MermaidMindmapModel;
  readonly design: import("./projection/options.js").MindmapDesign;
  readonly height: number;
  readonly showDesigns: boolean;
  readonly onDesignChange: (
    design: import("./projection/options.js").MindmapDesign,
  ) => void;
};
export type MindmapRendererHostProps =
  | MindmapReactHostProps
  | MindmapPreviewHostProps
  | MindmapImportHostProps
  | MindmapLabelActionsProps;
export type MindmapLabelActionsProps = ShapeTextEditDraftActions & {
  readonly surface: "label-actions";
};
export type MindmapImportHostProps = {
  readonly surface: "import";
  readonly host: import("@virgultum/std").EditorHost;
  readonly onClose: () => void;
};
export const mermaidMindmapRendererToken =
  defineMermaidFamilyReactRendererToken<MindmapRendererHostProps>("mindmap");
