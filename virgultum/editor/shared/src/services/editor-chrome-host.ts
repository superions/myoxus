// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { SelectionAction } from "./toolbar-service/presentation";

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { NoteDisplayMode } from "@virgultum/model";
import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";

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
  input: HTMLElement;
  getSnapshot: () => EditorDocumentPickerState;
  subscribe: (listener: () => void) => () => void;
  subscribeKeys: (listener: (event: KeyboardEvent) => void) => () => void;
  setAnchor: (element: HTMLElement | null) => void;
  activate: (id: string) => void;
  choose: (id: string) => void;
  cancel: () => void;
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
  action?: Readonly<{ kind: "retry" | "reload" | "limit"; run: () => void }>;
}>;

/** The editor owns preview DOM and its renderer; React only mounts the stable container. */
export type EditorDocumentCardControls = Readonly<{
  kind?: "linked" | "synced";
  mountBanner?: (container: HTMLDivElement | null) => void;
  deleted?: boolean;
  showBanner?: boolean;
  title: string;
  description: string;
  updated: string | null;
  loading: boolean;
  error: boolean;
  unavailable: boolean;
  empty: boolean;
  nodeReference: boolean;
  selected: boolean;
  inSurface: boolean;
  variant: string;
  height: number;
  width: number;
  mountPreview: (container: HTMLDivElement | null) => void;
  reload: () => void;
}>;

export type EditorChromeHost = {
  renderImageFallback: (
    controls: EditorImageFallbackControls,
  ) => TemplateResult;
  renderDocumentCard: (controls: EditorDocumentCardControls) => TemplateResult;
  renderAttachmentCard: (
    controls: EditorAttachmentCardControls,
  ) => TemplateResult;
  renderDocumentOutline: (controls: EditorOutlineControls) => TemplateResult;
  renderOutlineEntry: (controls: EditorOutlineEntryControls) => TemplateResult;
  renderCitationPreview: (controls: EditorCitationControls) => TemplateResult;
  renderEquation: (controls: EditorEquationControls) => TemplateResult;
  renderBlockCaption: (controls: EditorBlockCaptionControls) => TemplateResult;
  renderEmbedCardEdit: (
    controls: EditorEmbedCardEditControls,
  ) => TemplateResult;
  renderEmbedCardCreate: (
    controls: EditorEmbedCardCreateControls,
  ) => TemplateResult;
  renderTableMenu: (controls: EditorTableMenuControls) => TemplateResult;
  renderAttachmentRename: (
    controls: EditorAttachmentRenameControls,
  ) => TemplateResult;
  renderCodeToolbar: (controls: EditorCodeToolbarControls) => TemplateResult;
  renderDocumentPicker: (
    controls: EditorDocumentPickerControls,
  ) => TemplateResult;
  renderIframeStatusCard: (
    controls: EditorIframeStatusCardControls,
  ) => TemplateResult;
  renderIframeLinkEditor: (
    controls: EditorIframeLinkEditorControls,
  ) => TemplateResult;
  renderLinkEditor: (controls: EditorLinkEditorControls) => TemplateResult;
  renderReferenceEditor: (
    controls: EditorReferenceEditorControls,
  ) => TemplateResult;
  renderSelection: (controls: EditorSelectionControls) => TemplateResult;
  renderSlash: (controls: EditorSlashControls) => TemplateResult;
  renderZoom: (controls: EditorZoomControls) => TemplateResult;
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

export type EditorTableMenuControls = EditorInlinePopupControls & {
  actions: SelectionAction[];
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
