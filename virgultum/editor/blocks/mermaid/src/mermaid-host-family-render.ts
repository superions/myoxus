// SPDX-License-Identifier: AGPL-3.0-or-later

import { MermaidFamilyReactHostIdentifier } from "./families/runtime/react-host.js";
import type { MermaidEditorCapabilities } from "./families/runtime/editor-capabilities.js";
import type { MermaidSelectionActionModel } from "./families/runtime/shell-contract.js";
import type { MermaidTitlePresentation } from "./families/runtime/shell-contract.js";
import { createMermaidHostProjectionContext } from "./families/runtime/host-controller.js";
import { MermaidHostGfxRender } from "./mermaid-host-gfx-render.js";
import { exportMermaidMmdOwner } from "./edgeless-toolbar/mmd-file-actions.js";
import { getMermaidBlockSource } from "./utils.js";
import {
  readMermaidSessionState,
  writeMermaidSessionState,
} from "./families/runtime/session-state.js";

export abstract class MermaidHostFamilyRender extends MermaidHostGfxRender {
  protected get _familyActionTarget() {
    return this._hostState.familyActionTarget$.value;
  }
  protected set _familyActionTarget(value: HTMLElement | null) {
    this._hostState.familyActionTarget$.value = value;
  }
  protected get _familyHeaderActionTarget() {
    return this._hostState.familyHeaderActionTarget$.value;
  }
  protected set _familyHeaderActionTarget(value: HTMLElement | null) {
    this._hostState.familyHeaderActionTarget$.value = value;
  }
  private get _familySelectionAction() {
    return this._hostState.familySelectionAction$.value;
  }
  private set _familySelectionAction(
    value: MermaidSelectionActionModel | null,
  ) {
    this._hostState.familySelectionAction$.value = value;
  }
  protected get _familyTitlePresentationPreview() {
    return this._hostState.familyTitlePresentationPreview$.value;
  }
  protected set _familyTitlePresentationPreview(
    value: MermaidTitlePresentation | null,
  ) {
    this._hostState.familyTitlePresentationPreview$.value = value;
  }
  private readonly _familyTransientState = new Map<string, unknown>();
  private _pageSelectionActionInvoker: (() => void) | null = null;

  private _getFamilySessionState = (key: string) => {
    return readMermaidSessionState(this.store.id, this.model.id, key);
  };

  private _setFamilySessionState = (key: string, value: unknown) => {
    writeMermaidSessionState(this.store.id, this.model.id, key, value);
  };

  protected _handleFamilyActionTargetChange = (target: HTMLElement | null) => {
    if (this._familyActionTarget === target) return;
    this._familyActionTarget = target;
  };

  protected _handleFamilyHeaderActionTargetChange = (
    target: HTMLElement | null,
  ) => {
    if (this._familyHeaderActionTarget === target) return;
    this._familyHeaderActionTarget = target;
  };

  private _setFamilyTitlePresentationPreview = (
    presentation: MermaidTitlePresentation | null,
  ) => {
    if (this._familyTitlePresentationPreview === presentation) return;
    this._familyTitlePresentationPreview = presentation;
  };

  private _handleFamilySelectionActionChange = (
    action: MermaidSelectionActionModel | null,
  ) => {
    if (this._familySelectionAction === action) return;
    this._familySelectionAction = action;
  };

  protected _handleFamilySelectionAction() {
    if (this._familySelectionAction?.disabled === false) {
      this._familySelectionAction.onSelect();
    }
  }

  protected _handlePageSelectionAction() {
    if (!this._pageSelectionActionInvoker) return false;
    this._pageSelectionActionInvoker();
    return true;
  }

  protected _handlePageSelectionActionInvokerChange = (
    invoke: (() => void) | null,
  ) => {
    this._pageSelectionActionInvoker = invoke;
  };

  protected _hasFamilySelectionAction() {
    return this._familySelectionAction?.disabled === false;
  }

  protected _renderCapabilities(
    capabilities: MermaidEditorCapabilities,
    displayOnly = false,
  ) {
    return capabilities.project(
      createMermaidHostProjectionContext({
        commitSource: (source, options) =>
          this._setSourceFromControl(source, options),
        embedded: this._isInEdgelessMode(),
        exportMmd: () => exportMermaidMmdOwner(this.model),
        copySource: () =>
          this.std.clipboard.writeToClipboard(async (items) => ({
            ...items,
            "text/plain": getMermaidBlockSource(this.model.props),
          })),
        getReactHost: () =>
          this.std.getOptional(MermaidFamilyReactHostIdentifier) ?? null,
        getActionTarget: () => this._familyActionTarget,
        getHeaderActionTarget: () => this._familyHeaderActionTarget,
        getPageViewport: () =>
          this._getPageViewportProjection(displayOnly ? "view" : "visual"),
        getReadonly: () => this.store.readonly,
        getSource: () => getMermaidBlockSource(this.model.props),
        getSelectionAction: () => this._familySelectionAction,
        getSessionState: this._getFamilySessionState,
        getTransientState: (key) => this._familyTransientState.get(key),
        openSource: () => this._setShellMode("source"),
        renderGfx: (visualModel, options) =>
          this._renderGfxEditor(visualModel, {
            ...options,
            actionTarget: this._familyActionTarget,
          }),
        renderSourceFirst: () => null,
        setSelectionAction: this._handleFamilySelectionActionChange,
        setSessionState: this._setFamilySessionState,
        setTitlePresentationPreview: this._setFamilyTitlePresentationPreview,
        setTransientState: (key, value) => {
          if (value === undefined) this._familyTransientState.delete(key);
          else this._familyTransientState.set(key, value);
        },
      }),
      displayOnly,
    );
  }
}
