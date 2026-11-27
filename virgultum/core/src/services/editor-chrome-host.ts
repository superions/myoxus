// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { BlockComponent } from "../runtime/view";
import type { ReadonlySignal } from "@preact/signals-core";
import type { SelectionAction } from "./toolbar-service/presentation";

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type {
  EventBlockModel,
  NoteDisplayMode,
  ReferenceParams,
} from "../models/index";
import { createIdentifier } from "../primitives/di/index";
import type { ExtensionType } from "../store/index";
import type { MyoxusHostService } from "./host/myoxus-host-service";
import type { ReferenceIconName } from "./doc-display-meta-service";

export type EditorZoomState = Readonly<{
  zoom: number;
  locked: boolean;
  visible: boolean;
}>;

/** Snapshot and commands belong to the mounted viewport, including after a menu closes. */
export type EditorZoomControls = {
  getSnapshot: () => EditorZoomState;
  subscribe: (listener: () => void) => () => void;
  step: (direction: -1 | 1) => void;
  setZoom: (zoom: number) => void;
  fit: () => void;
};

export type EditorCodeToolbarState = Readonly<{
  language: string;
  languageName: string;
  languages: readonly {
    value: string;
    label: string;
    aliases?: readonly string[];
  }[];
  readonly: boolean;
  floating?: boolean;
  primary: SelectionAction[];
  more: SelectionAction[];
}>;
export type EditorCodeToolbarControls = {
  getSnapshot: () => EditorCodeToolbarState;
  subscribe: (listener: () => void) => () => void;
  chooseLanguage: (language: string) => void;
  setActive: (active: boolean) => void;
};

export type EditorSlashOption = Readonly<{
  id: string;
  label: string;
  description?: string;
  help?: string;
  shortcut?: string;
  icon?: MyoxusIconExportName;
  group: string;
  submenu: boolean;
}>;
export type EditorSlashState = Readonly<{
  open: boolean;
  query: string;
  options: readonly EditorSlashOption[];
  depth: number;
  heading?: string;
  returnTo?: string;
}>;
/** The scoped editor owns query/commands; the native Combobox store owns option selection. */
export type EditorSlashControls = {
  getSnapshot: () => EditorSlashState;
  subscribe: (listener: () => void) => () => void;
  subscribeKeys: (listener: (event: KeyboardEvent) => void) => () => void;
  input: HTMLElement;
  setAnchor: (anchor: HTMLElement | null) => void;
  choose: (id: string) => void;
  back: () => void;
  cancel: () => void;
};
export type EditorSelectionState = Readonly<{
  open: boolean;
  key: string;
  placement: "top" | "top-start" | "bottom-end";
  primary: SelectionAction[];
  more: SelectionAction[];
}>;
export type EditorSelectionControls = {
  getSnapshot: () => EditorSelectionState;
  subscribe: (listener: () => void) => () => void;
  setAnchor: (element: HTMLElement | null) => void;
  setFloating: (element: HTMLElement | null) => void;
  dismiss: () => void;
  /** Return mouse commands/menu dismissal to this editor's retained selection. */
  activate: () => void;
};

export type EditorDocumentPickerItem = Readonly<{
  id: string;
  name: string;
  icon: MyoxusIconExportName;
  avatar?: string;
  highlights?: readonly (readonly [number, number])[];
  color?: string;
  disabled?: boolean;
}>;
export type EditorDocumentPickerState = Readonly<{
  open: boolean;
  query: string;
  preferredId?: string;
  groups: readonly Readonly<{
    id: string;
    name: string;
    loading: boolean;
    emptyMessage?: string;
    items: readonly EditorDocumentPickerItem[];
  }>[];
}>;

/** Input and commands stay in Virgultum; native Combobox owns option navigation. */
export type EditorDocumentPickerControls = {
  /** A keyboard-docked host supplies its own viewport geometry instead of a floating anchor. */
  presentation?: "docked";
  input: HTMLElement;
  getSnapshot: () => EditorDocumentPickerState;
  subscribe: (listener: () => void) => () => void;
  subscribeKeys: (listener: (event: KeyboardEvent) => void) => () => void;
  setAnchor: (element: HTMLElement | null) => void;
  activate: (id: string) => void;
  choose: (id: string) => void;
  cancel: () => void;
};

export type EditorImportControls = {
  getSnapshot: () => Readonly<{ loading: boolean }>;
  subscribe: (listener: () => void) => () => void;
  choose: (format: "html" | "markdown") => void;
  close: () => void;
};

export type EditorEquationControls = EditorInlinePopupControls & {
  position: "bottom" | "bottom-start";
  restoreFocus: () => void;
  syncSourceRange: () => void;
  mountSource: (container: HTMLDivElement | null) => void;
};

export type EditorAttachmentCardControls = Readonly<{
  inSurface: boolean;
  selected: boolean;
  title: string;
  description: string;
  fileType: string;
  loading: boolean;
  error: boolean;
  vertical: boolean;
  /** Preserve the authored footnote label on an attachment source card. */
  citationIdentifier?: string;
  action?: Readonly<{ kind: "retry" | "reload" | "limit"; run: () => void }>;
  /** Expose resource status from a compact anchor without replacing cached media. */
  statusPopover?: boolean;
}>;

/**
 * Plain snapshot of the block's preview state and guarded commands. The native
 * block re-evaluates this on every reactive render; the React view is stateless.
 */
export type EditorBookmarkCardControls = Readonly<{
  /** Authored source label; citation controllers retain their pointer commands. */
  citationIdentifier?: string;
  inSurface: boolean;
  selected: boolean;
  commentHighlighted: boolean;
  style: "horizontal" | "list" | "vertical" | "cube";
  url: string;
  title: string | null;
  description: string | null;
  /** Image-proxy URL for the site icon, or null when unavailable. */
  icon: string | null;
  /** Image-proxy URL for the banner image, or null when unavailable. */
  image: string | null;
  loading: boolean;
  error: boolean;
  /** Opens the normalized URL in a new tab; no-op without a valid link. */
  open: () => void;
  /** Selects the block when the parent and readonly state allow it. */
  select: () => void;
}>;

/** The mounted forge block owns resources and guarded navigation/selection. */
export type EditorGithubCardControls = Readonly<{
  inSurface: boolean;
  selected: boolean;
  style: "horizontal" | "list" | "vertical" | "cube";
  family: string | null;
  host: string;
  repository: string;
  date: string;
  title: string | null;
  description: string | null;
  image: string | null;
  loading: boolean;
  type: "issue" | "pr";
  status: string | null;
  statusReason: string | null;
  assignees: readonly string[] | null;
  open: () => void;
  openAssignee: (assignee: string) => void;
  select: () => void;
}>;

/** Event reads, date formatting, permissions and dialog commands stay in the block. */
export type EditorEventReference = {
  model: EventBlockModel;
  readonly: boolean;
  host: Pick<MyoxusHostService, "resolveEventData" | "openEventEditDialog">;
};

export type EditorDocumentCardControls = Readonly<{
  title: string;
  selected: boolean;
  inSurface: boolean;
}> &
  (
    | Readonly<{
        /** A source citation has no preview mount or preview lifecycle. */
        citationIdentifier: string;
        citationIcon?: ReferenceIconName;
      }>
    | Readonly<{
        citationIdentifier?: undefined;
        kind?: "linked" | "synced";
        mountBanner?: (container: HTMLDivElement | null) => void;
        deleted?: boolean;
        showBanner?: boolean;
        description: string;
        updated: string | null;
        loading: boolean;
        error: boolean;
        unavailable: boolean;
        empty: boolean;
        nodeReference: boolean;
        variant: string;
        height: number;
        width: number;
        mountPreview: (container: HTMLDivElement | null) => void;
        reload: () => void;
      }>
  );

export type EditorCodePreviewControls = {
  language: "html" | "mermaid" | "typst";
  getSource: () => string;
  subscribe: (listener: () => void) => () => void;
  convertMermaid?: () => void;
};

/** Existing presentation ordering; document hierarchy and frame geometry never change. */
export type EditorFrameOrderControls = Readonly<{
  items: readonly Readonly<{ id: string; title: string }>[];
  embedded: boolean;
  readonly: boolean;
  move: (id: string, before: string | null) => void;
}>;

/** Controller-owned elements retain preview/editor lifetimes and drag identity. */
export type EditorFrameNavigatorControls = {
  emptyLabel: string;
  items: readonly {
    id: string;
    mount: (element: HTMLElement | null) => void;
  }[];
  setList: (element: HTMLDivElement | null) => void;
  indicatorY?: number;
};
export type EditorFrameCardControls = {
  selected: boolean;
  mountTitle: (element: HTMLDivElement | null) => void;
  mountPreview: (element: HTMLDivElement | null) => void;
  select: (event: MouseEvent) => void;
  fit: (event: MouseEvent) => void;
  drag: (event: MouseEvent) => void;
  count?: number;
};
export type EditorFrameTitleControls = {
  index: number;
  title: string;
  setContainer: (element: HTMLDivElement | null) => void;
  setTitle: (element: HTMLSpanElement | null) => void;
  edit: (event: MouseEvent) => void;
};

export type EditorCanvasPopoverToolId =
  "templates" | "frame" | "connector" | "note" | "pen" | "eraser" | "shape";

export type EditorCanvasToolbarItem =
  | {
      readonly type: "control";
      readonly controls: EditorCanvasToolControls;
      readonly menu?: SelectionAction;
    }
  | {
      readonly type: "popover-tool";
      readonly tool: EditorCanvasPopoverToolId;
      readonly edgeless: BlockComponent;
      readonly menu?: SelectionAction;
    };

/** Host payload for the React Edgeless canvas dock mounted on `<edgeless-toolbar-widget>`. */
export type EditorCanvasDockControls = Readonly<{
  edgeless: BlockComponent;
  anchor: HTMLElement;
  resolveTools: (closeActivePopover: () => void) => Readonly<{
    quick: readonly EditorCanvasToolbarItem[];
    senior: readonly EditorCanvasToolbarItem[];
  }>;
}>;
export type EditorCanvasToolControls = {
  action: SelectionAction;
  /** Resolve the current catalog on opening/search, never during module registration. */
  menu?: {
    searchPlaceholder: string;
    actions: (query: string) => SelectionAction[];
    onOpen?: () => void;
  };
  expanded?: boolean;
  separatorBefore?: boolean;
  /** Static SVG markup for retained canvas tool artwork. */
  artworkSvg?: string;
  /** Mounts a live native DOM artwork element into the tool button slot. */
  mountArtwork?: (host: HTMLElement) => (() => void) | void;
  nativeArtwork?: unknown;
  /** Retained artwork and drag hit boxes, not theme spacing. */
  artworkBounds?: Readonly<{ width: number; height: number }>;
  artworkColor?: string;
};

export type EditorCanvasMenuControls = {
  tools?: readonly EditorCanvasToolControls[];
  actions: readonly SelectionAction[];
};

export type EditorCanvasTemplatePreview =
  | Readonly<{ kind: "svg"; markup: string }>
  | Readonly<{ kind: "image"; src: string }>
  | Readonly<{ kind: "fallback" }>;

/** Snapshot of the existing catalog; template jobs and placement stay in Virgultum. */
export type EditorCanvasTemplateControls = {
  query: string;
  categories: readonly string[];
  category: string;
  loading: boolean;
  readonly: boolean;
  search: (value: string) => void;
  chooseCategory: (category: string) => void;
  items: readonly {
    id: string;
    label: string;
    preview: EditorCanvasTemplatePreview;
    loading: boolean;
    dragging: boolean;
    mouseDown: (element: HTMLElement, event: MouseEvent) => void;
    touchStart: (element: HTMLElement, event: TouchEvent) => void;
    activate: () => void;
  }[];
};

/** Reactive snapshot for the Edgeless NoteSlicer overlay. */
export type EditorNoteSlicerControls = Readonly<{
  buttonLeft: number;
  buttonTop: number;
  buttonLabel: string;
  lineWidth: number;
  activeIndex: number;
  lines: readonly Readonly<{ left: number; top: number }>[];
  slice: () => void;
}>;

/** Reactive snapshot for the Edgeless auto-connect page-index badges and navigator. */
export type EditorAutoConnectControls = Readonly<{
  visibleGroups: readonly Readonly<{
    id: string;
    left: number;
    top: number;
    onHoverChange: (hovered: boolean) => void;
    items: readonly Readonly<{
      index: number;
      offsetX: number;
      offsetY: number;
      active: boolean;
      toggle: () => void;
    }>[];
  }>[];
  hiddenNotes: readonly Readonly<{
    id: string;
    left: number;
    top: number;
  }>[];
  navigator: Readonly<{
    left: number;
    top: number;
    previous: boolean;
    next: boolean;
    navigate: (direction: -1 | 1) => void;
  }> | null;
}>;

/** Reactive snapshot for Edgeless auto-complete directional triggers and target panel. */
export type EditorAutoCompleteControls = Readonly<{
  triggers: Readonly<{
    rect: Readonly<{
      left: number;
      top: number;
      width: number;
      height: number;
      rotate: number;
    }>;
    items: readonly Readonly<{
      key: string;
      family: boolean;
      hidden?: boolean;
      width: number;
      height: number;
      transform: string;
      label: string;
      icon?: MyoxusIconExportName;
      preview: (active: boolean) => void;
      pointerDown: (event: PointerEvent) => void;
      activate: () => void;
    }>[];
  }> | null;
  panel: Readonly<{
    left: number;
    top: number;
    label: string;
    options: readonly Readonly<{
      label: string;
      icon: MyoxusIconExportName;
      preview: (active: boolean) => void;
      choose: () => void;
    }>[];
    close: () => void;
  }> | null;
}>;

/** Presentation only; the table keeps live identity, readonly checks and drag ownership. */
export type EditorTableControl = {
  action: SelectionAction;
  menu?: boolean;
  dragBadge?: string;
  setElement?: (element: HTMLButtonElement | null) => void;
  mouseDown?: (element: HTMLButtonElement, event: MouseEvent) => void;
};

export type EditorDisclosureControl = Readonly<{
  collapsed: boolean;
  toggle: () => void;
}>;

export type EditorIconPickerControls = EditorInlinePopupControls & {
  onSelect: (icon?: import("./icon-picker-service/index.js").IconData) => void;
};

export type EditorCanvasPopoverPosition =
  "top" | "bottom" | "top-start" | "top-end" | "bottom-start" | "bottom-end";

export type EditorCanvasPopoverContent =
  | Readonly<{ kind: "menu"; controls: EditorCanvasMenuControls }>
  | Readonly<{ kind: "frame-order"; controls: EditorFrameOrderControls }>
  | Readonly<{ kind: "templates"; controls: EditorCanvasTemplateControls }>
  | Readonly<{
      kind: "menu-with-frame-order";
      menu: EditorCanvasMenuControls;
      frameOrder: EditorFrameOrderControls;
    }>
  | Readonly<{
      kind: "native";
      mount: (host: HTMLElement) => (() => void) | void;
    }>;

/** Native Mantine Popover host for canvas dock submenus, templates, and frame menus. */
export type EditorCanvasPopoverControls = Readonly<{
  opened: boolean;
  onClose: () => void;
  position?: EditorCanvasPopoverPosition;
  offset?: number;
  withArrow?: boolean;
  closeOnClickOutside?: boolean;
  label?: string;
  testId?: string;
  trigger?: EditorCanvasToolControls;
  content: EditorCanvasPopoverContent;
}>;

/** Presentation toolbar rendered natively through Mantine ToolbarSurface and Popover. */
export type EditorPresentationToolbarControls = Readonly<{
  previous: EditorCanvasToolControls;
  next: EditorCanvasToolControls;
  title: string;
  count: string;
  focusCurrentFrame: () => void;
  fullscreen: EditorCanvasToolControls;
  frameOrder?: EditorCanvasPopoverControls;
  settings: EditorCanvasPopoverControls;
  stop: EditorCanvasToolControls;
}>;

export type EditorSurfaceRefPlaceholderControls = Readonly<{
  notFound: boolean;
  icon: MyoxusIconExportName;
  title: string;
  description: string;
}>;

export type EditorHtmlEmbedControls = Readonly<{
  empty: boolean;
  emptyLabel: string;
  title: string;
  selected: boolean;
  select: (event: MouseEvent) => void;
  open: (event: MouseEvent) => void;
  mountFrame: (host: HTMLElement) => (() => void) | void;
}>;

export type EditorChromeHost = {
  mountTableControl: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorTableControl | null>,
  ) => () => void;
  mountDisclosureControl?: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorDisclosureControl | null>,
  ) => () => void;
  mountIconPicker?: (
    anchor: HTMLElement,
    controls: EditorIconPickerControls,
  ) => () => void;
  mountCanvasPopover?: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorCanvasPopoverControls | null>,
  ) => () => void;
  mountSurfaceRefPlaceholder?: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorSurfaceRefPlaceholderControls | null>,
  ) => () => void;
  mountHtmlEmbed?: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorHtmlEmbedControls | null>,
  ) => () => void;
  mountNoteSlicer: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorNoteSlicerControls | null>,
  ) => () => void;
  mountAutoConnect: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorAutoConnectControls | null>,
  ) => () => void;
  mountAutoComplete: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorAutoCompleteControls | null>,
  ) => () => void;
  mountCanvasMenu: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorCanvasMenuControls | null>,
  ) => () => void;
  mountCanvasDock: (
    anchor: HTMLElement,
    controls: EditorCanvasDockControls,
  ) => () => void;
  mountFrameNavigator: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorFrameNavigatorControls | null>,
  ) => () => void;
  mountFrameCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorFrameCardControls | null>,
  ) => () => void;
  mountFrameTitle: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorFrameTitleControls | null>,
  ) => () => void;
  mountCodePreview: (
    anchor: HTMLElement,
    controls: EditorCodePreviewControls,
  ) => () => void;
  mountImageFallback: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorImageFallbackControls | null>,
  ) => () => void;
  mountDocumentCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorDocumentCardControls | null>,
  ) => () => void;
  mountAttachmentCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorAttachmentCardControls | null>,
  ) => () => void;
  mountBookmarkCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorBookmarkCardControls | null>,
  ) => () => void;
  mountGithubCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorGithubCardControls | null>,
  ) => () => void;
  mountEventReference: (
    anchor: HTMLElement,
    controls: EditorEventReference,
  ) => () => void;
  mountHtmlFullscreenToolbar: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorHtmlFullscreenControls | null>,
  ) => () => void;
  mountYoutubeCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorYoutubeCardControls | null>,
  ) => () => void;
  mountFigmaCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorFigmaCardControls | null>,
  ) => () => void;
  mountLoomCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorLoomCardControls | null>,
  ) => () => void;
  mountDocumentOutline: (
    anchor: HTMLElement,
    controls: EditorOutlineControls,
  ) => () => void;
  mountOutlineEntry: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorOutlineEntryControls | null>,
  ) => () => void;
  mountCitationPreview: (
    anchor: HTMLElement,
    controls: EditorCitationControls,
  ) => () => void;
  mountEquation: (
    anchor: HTMLElement,
    controls: EditorEquationControls,
  ) => () => void;
  mountBlockCaption: (
    anchor: HTMLElement,
    controls: ReadonlySignal<EditorBlockCaptionControls>,
  ) => () => void;
  mountEmbedCardEdit: (
    anchor: HTMLElement,
    controls: EditorEmbedCardEditControls,
  ) => () => void;
  mountEmbedTargetPicker?: (
    anchor: HTMLElement,
    controls: EditorEmbedTargetPickerControls,
  ) => () => void;
  mountEmbedCardCreate: (
    anchor: HTMLElement,
    controls: EditorEmbedCardCreateControls,
  ) => () => void;
  mountActionMenu: (
    anchor: HTMLElement,
    controls: EditorActionMenuControls,
  ) => () => void;
  mountAttachmentRename: (
    anchor: HTMLElement,
    controls: EditorAttachmentRenameControls,
  ) => () => void;
  mountCodeToolbar: (
    anchor: HTMLElement,
    controls: EditorCodeToolbarControls,
  ) => () => void;
  mountImport: (
    container: HTMLElement,
    controls: EditorImportControls,
  ) => () => void;
  mountDocumentPicker: (
    anchor: HTMLElement,
    controls: EditorDocumentPickerControls,
  ) => () => void;
  mountIframeStatusCard: (
    anchor: HTMLElement,
    state: ReadonlySignal<EditorIframeStatusCardControls | null>,
  ) => () => void;
  mountIframeLinkEditor: (
    anchor: HTMLElement,
    controls: EditorIframeLinkEditorControls,
  ) => () => void;
  mountLinkEditor: (
    anchor: HTMLElement,
    controls: EditorLinkEditorControls,
  ) => () => void;
  mountReferenceEditor: (
    anchor: HTMLElement,
    controls: EditorReferenceEditorControls,
  ) => () => void;
  mountSelection: (
    anchor: HTMLElement,
    controls: EditorSelectionControls,
  ) => () => void;
  mountSlash: (
    anchor: HTMLElement,
    controls: EditorSlashControls,
  ) => () => void;
  mountZoom?: (anchor: HTMLElement, controls: EditorZoomControls) => () => void;
};

export type EditorOutlineEntry = Readonly<{
  id: string;
  label: string;
  level: number;
  icon: MyoxusIconExportName;
  segments?: readonly Readonly<{
    text: string;
    docId?: string;
    unavailable?: boolean;
  }>[];
}>;
export type EditorOutlineEntryControls = {
  entry: EditorOutlineEntry;
  active: boolean;
  showIcon: boolean;
  disabled?: boolean;
  activate: (multiple?: boolean) => void;
};
export type EditorOutlineState = Readonly<{
  labels: Readonly<
    Record<
      | "title"
      | "emptyPlaceholder"
      | "previewSettings"
      | "visibilityAndSort"
      | "hiddenContents"
      | "hiddenNoticeTitle"
      | "hiddenNoticeBody"
      | "hiddenNoticeActionPrefix"
      | "hiddenNoticeActionSuffix"
      | "modeBoth"
      | "modeEdgeless"
      | "modePage"
      | "next"
      | "previous",
      string
    >
  >;
  hideHeader: boolean;
  activeId: string | null;
  showIcons: boolean;
  sorting: boolean;
  edgeless: boolean;
  readonly: boolean;
  notice: boolean;
  entries: readonly EditorOutlineEntry[];
  title?: EditorOutlineEntry;
  previous?: number;
  next?: number;
  notes: readonly Readonly<{
    id: string;
    index: number;
    mode: NoteDisplayMode;
    selected: boolean;
    entries: readonly EditorOutlineEntry[];
  }>[];
  drop?: Readonly<{ id: string; edge: "top" | "bottom" }>;
}>;
export type EditorOutlineControls = {
  getSnapshot: () => EditorOutlineState;
  subscribe: (listener: () => void) => () => void;
  navigate: (id: string) => void;
  window: (index: number) => void;
  toggleIcons: () => void;
  toggleSorting: () => void;
  dismissNotice: () => void;
  select: (id: string, multiple: boolean) => void;
  fit: (id: string) => void;
  changeMode: (id: string, mode: NoteDisplayMode) => void;
  history: (redo: boolean) => void;
  bindNote: (element: HTMLElement, id: string) => () => void;
  bindScroll: (element: HTMLDivElement | null) => void | (() => void);
};

export type EditorCitationState = Readonly<{
  kind: "url" | "doc" | "attachment";
  title: string;
  description?: string;
  tooltip: string;
  loading: boolean;
  available: boolean;
  docId?: string;
  fileType?: string;
  image?: string;
}>;
export type EditorCitationControls = {
  getSnapshot: () => EditorCitationState;
  subscribe: (listener: () => void) => () => void;
  activate: () => void;
};

/** Authored value and Enter navigation belong to the caption's block session. */
export type EditorBlockCaptionControls = {
  getSnapshot: () => string;
  subscribe: (listener: () => void) => () => void;
  readonly: boolean;
  focusRequest: number;
  change: (value: string) => void;
  enter: (input: HTMLTextAreaElement) => boolean;
  setFocused: (focused: boolean) => void;
};

/** Form lifetime and range geometry are owned by the scoped editor. */
export type EditorInlinePopupControls = {
  setAnchor: (element: HTMLElement | null) => void;
  close: () => void;
};

export type EditorEmbedCardCreateControls = EditorInlinePopupControls & {
  title: string;
  description: string;
  isValidUrl: (url: string) => boolean;
  confirm: (url: string) => void;
};

export type EditorEmbedCardEditControls = EditorInlinePopupControls & {
  title: string;
  description: string;
  internal: boolean;
  mode: "linked" | "synced" | "external";
  canReset: boolean;
  confirm: (title: string, description: string) => void;
  reset: () => void;
};

export type EditorEmbedTargetPickerControls = EditorInlinePopupControls & {
  pageId: string;
  workspaceId?: string;
  params?: ReferenceParams;
  apply: (params: ReferenceParams | undefined) => void;
};

export type EditorActionMenuControls = EditorInlinePopupControls & {
  label: string;
  actions: SelectionAction[];
  menuRef?: (element: HTMLElement | null) => void;
};

export type EditorLinkEditorControls = EditorInlinePopupControls & {
  editing: boolean;
  text: string;
  url: string;
  isValidUrl: (url: string) => boolean;
  confirm: (url: string, text: string) => void;
};

export type EditorReferenceEditorControls = EditorInlinePopupControls & {
  title: string;
  confirm: (title: string) => void;
  reset: () => void;
};

export type EditorAttachmentRenameControls = EditorInlinePopupControls & {
  name: string;
  extension: string;
  confirm: (name: string) => void;
};

export const EditorChromeHostIdentifier =
  createIdentifier<EditorChromeHost>("EditorChromeHost");

export type EditorHtmlFullscreenControls = Readonly<{
  copied: boolean;
  autoHide: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setAutoHide: (enabled: boolean) => void;
  close: () => void;
  copy: () => void;
}>;

export type EditorYoutubeCardControls = Readonly<{
  title: string;
  description: string | null;
  creator: string | null;
  creatorImage: string | null;
  image: string | null;
  videoId: string | null;
  url: string;
  loading: boolean;
  printImage: boolean;
  selected: boolean;
  showOverlay: boolean;
  /** Delegate selection to the owning Page/Gfx block. */
  select: (event: MouseEvent) => void;
  open: () => void;
}>;

export type EditorFigmaCardControls = Readonly<{
  title: string;
  description: string | null;
  url: string;
  iframeUrl: string;
  selected: boolean;
  showOverlay: boolean;
  /** Preserve the owning Page/Gfx block's existing event and selection policy. */
  select: (event: MouseEvent) => void;
  open: () => void;
}>;

export function EditorChromeHostExtension(
  host: EditorChromeHost,
): ExtensionType {
  return { setup: (di) => di.addImpl(EditorChromeHostIdentifier, () => host) };
}

export type EditorIframeLinkEditorControls = EditorInlinePopupControls & {
  editing: boolean;
  title?: string;
  description?: string;
  placeholder?: string;
  showCloseButton: boolean;
  confirm: (url: string) => Promise<void>;
};

export type EditorIframeStatusCardControls = {
  status: "idle" | "loading" | "error";
  message: string;
  inSurface: boolean;
  selected: boolean;
  readonly: boolean;
  edit: (anchor: HTMLElement) => void;
  retry: () => Promise<void>;
};

export type EditorImageFallbackControls = Readonly<{
  loading: boolean;
  error: boolean;
  description: string;
  inSurface: boolean;
}>;

/** Resource state and Page/Gfx selection remain owned by the mounted Loom block. */
export type EditorLoomCardControls = Readonly<{
  title: string;
  description: string | null;
  image: string | null;
  videoId: string | null;
  url: string;
  loading: boolean;
  selected: boolean;
  showOverlay: boolean;
  select: (event: MouseEvent) => void;
  open: () => void;
}>;
