// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidSourceEditIntent } from "../../mermaid-editor-events.js";
import type {
  MermaidPageViewportState,
  MermaidPageZoom,
  MermaidPageZoomChangeIntent,
} from "../../mermaid-page-viewport-state.js";
import type {
  MermaidPageSelectionState,
  MermaidPageSelectionTool,
} from "../../mermaid-page-selection-state.js";

export type MermaidShellMode = "source" | "view" | "visual";

export type MermaidFamilyActionModel = {
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly onSelect?: () => void;
  readonly popoverProjection?: unknown;
};

export type MermaidFamilyActionContribution = {
  readonly actions: ReadonlyArray<MermaidFamilyActionModel>;
  readonly portal: boolean;
  readonly selectionAction?: MermaidSelectionActionModel | null;
};

export type MermaidSelectionActionModel = {
  readonly confirmation?: {
    readonly description: string;
    readonly items?: readonly string[];
  };
  readonly disabled: boolean;
  readonly label: string;
  readonly onSelect: () => void;
};

export type MermaidShellNoticeReactHostProps = {
  readonly actions?: ReadonlyArray<{
    readonly disabled?: boolean;
    readonly id: string;
    readonly label: string;
    readonly onSelect: () => void;
  }>;
  readonly message: string;
  readonly title: string;
  readonly tone: "error" | "warning";
};

export type MermaidEmbeddedTitleReactHostProps = {
  readonly onActionTargetChange: (target: HTMLElement | null) => void;
  readonly onTitleChange: (value: string) => void;
  readonly placeholder: string;
  readonly readonly: boolean;
  readonly title: string;
  readonly titlePresentation?: MermaidTitlePresentation;
};

export type MermaidTitlePresentation = {
  readonly fontSize?: number;
  readonly padding?: number;
  readonly visible: boolean;
};

export type MermaidPageSelectionProjection = {
  readonly onToolChange: (tool: MermaidPageSelectionTool) => boolean;
  readonly state: MermaidPageSelectionState;
};

/** Existing document/visual history exposed to a family-owned action slot. */
export type MermaidHistoryActions = Pick<
  MermaidBlockShellReactHostProps,
  "canUndo" | "canRedo" | "onUndo" | "onRedo"
> & {
  readonly subscribe?: (refresh: () => void) => () => void;
};

export type MermaidBlockShellReactHostProps = {
  readonly actions: MermaidFamilyActionContribution | null;
  readonly body: unknown;
  readonly bodyNotice?: MermaidShellNoticeReactHostProps;
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly emptyVisual?: {
    readonly onBlankDiagram: () => void;
    readonly onFileImport: (event: Event) => void;
    readonly onImportClick: () => void;
    readonly onPasteSource: () => void;
  };
  readonly focused: boolean;
  readonly labels: {
    readonly ariaBlock: string;
    readonly controls: string;
    readonly editor: string;
    readonly emptyBlank: string;
    readonly emptyImport: string;
    readonly emptyPaste: string;
    readonly previewEmpty: string;
    readonly pageZoom: string;
    readonly pageZoomAuto: string;
    readonly pageZoomHelp: string;
    readonly pageZoomPercent: (percent: number) => string;
    readonly pageCenter: string;
    readonly pageSelectionBox: string;
    readonly pageSelectionPointer: string;
    readonly pageSelectionTools: string;
    readonly source: string;
    readonly sourcePlaceholder: string;
    readonly sourcePreview: string;
    readonly titlePlaceholder: string;
    readonly view: string;
    readonly visual: string;
  };
  readonly mode: MermaidShellMode;
  readonly modeDisabled?: boolean;
  readonly pageViewport: MermaidPageViewportState;
  readonly pageSelection: MermaidPageSelectionProjection | null;
  readonly pageZoom: MermaidPageZoom;
  readonly pageZoomDisabled: boolean;
  readonly pageCenterDisabled: boolean;
  readonly onBlockKeydown: (event: KeyboardEvent) => void;
  readonly onActionTargetChange: (target: HTMLElement | null) => void;
  readonly onHeaderActionTargetChange: (target: HTMLElement | null) => void;
  readonly onModeChange: (mode: MermaidShellMode) => void;
  readonly onPageCenter: () => void;
  readonly onPageZoomChange: (intent: MermaidPageZoomChangeIntent) => void;
  readonly onRedo: () => void;
  readonly onSelect: (event: Event) => void;
  readonly onSelectionActionInvokerChange: (
    invoke: (() => void) | null,
  ) => void;
  readonly onSourceEdit: (intent: MermaidSourceEditIntent) => void;
  readonly onTitleChange: (value: string) => void;
  readonly onUndo: () => void;
  readonly readonly: boolean;
  readonly showView: boolean;
  readonly showPageActions: boolean;
  readonly showPageViewportControls: boolean;
  readonly source: string;
  readonly typeLabel: string;
  readonly sourceFirst: boolean;
  readonly sourceState:
    "empty" | "invalid" | "pending" | "source-first" | "valid";
  readonly staleProjection: boolean;
  readonly sourcePreview: unknown;
  readonly title: string;
  readonly titlePresentation?: MermaidTitlePresentation;
  readonly usesGfxOnlyDiagram: boolean;
};
