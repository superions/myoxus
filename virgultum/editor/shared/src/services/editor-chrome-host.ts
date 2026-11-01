// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { SelectionAction } from "./toolbar-service/presentation";

import type { MyoxusIconExportName } from "@myoxus/icons/names";
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

export type EditorChromeHost = {
  renderLinkEditor: (controls: EditorLinkEditorControls) => TemplateResult;
  renderReferenceEditor: (
    controls: EditorReferenceEditorControls,
  ) => TemplateResult;
  renderSelection: (controls: EditorSelectionControls) => TemplateResult;
  renderSlash: (controls: EditorSlashControls) => TemplateResult;
  renderZoom: (controls: EditorZoomControls) => TemplateResult;
};

/** Form lifetime and range geometry are owned by the scoped editor. */
export type EditorInlinePopupControls = {
  setAnchor: (element: HTMLElement | null) => void;
  close: () => void;
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

export const EditorChromeHostIdentifier =
  createIdentifier<EditorChromeHost>("EditorChromeHost");

export function EditorChromeHostExtension(
  host: EditorChromeHost,
): ExtensionType {
  return { setup: (di) => di.addImpl(EditorChromeHostIdentifier, () => host) };
}
