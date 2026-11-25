import { computed, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  type EditorKeyboardPanelControls,
  resolveLegacyEditorText,
} from "@virgultum/core/services";

import type {
  KeyboardToolbarActionItem,
  KeyboardToolbarContext,
  KeyboardToolPanelConfig,
  KeyboardToolPanelGroup,
} from "./config.js";

export const MYOXUS_KEYBOARD_TOOL_PANEL = "myoxus-keyboard-tool-panel";

export class MyoxusKeyboardToolPanel extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _revision$ = signal(0);

  private _config: KeyboardToolPanelConfig | null = null;
  private _context!: KeyboardToolbarContext;

  private _mountHost: HTMLDivElement | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedStd: BlockStdScope | null = null;

  get config(): KeyboardToolPanelConfig | null {
    return this._config;
  }
  set config(value: KeyboardToolPanelConfig | null) {
    this._config = value;
    this._bump();
  }

  get context(): KeyboardToolbarContext {
    return this._context;
  }
  set context(value: KeyboardToolbarContext) {
    const changed = this._context?.std !== value?.std;
    this._context = value;
    if (changed && this.isConnected) {
      this._bindStd();
    }
    this._bump();
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private readonly _handleItemClick = (item: KeyboardToolbarActionItem) => {
    if (item.disableWhen && item.disableWhen(this.context)) return;
    if (item.action) {
      Promise.resolve(item.action(this.context)).catch(console.error);
    }
  };

  private readonly _controls$ = computed<EditorKeyboardPanelControls | null>(
    () => {
      void this._revision$.value;
      if (!this._config || !this._context) return null;
      const i18n =
        this._context.std.getOptional(EditorI18nProvider) ?? undefined;
      void i18n?.locale$.value;
      const text = (label: string) =>
        resolveLegacyEditorText(label, i18n) ?? label;
      const groups = this._config.groups
        .map((group) =>
          typeof group === "function" ? group(this._context) : group,
        )
        .filter((group): group is KeyboardToolPanelGroup => group !== null)
        .map((group) => ({
          label: text(group.name),
          actions: group.items
            .filter((item) => item.showWhen?.(this._context) ?? true)
            .map((item, index) => ({
              id: `${group.name}:${index}`,
              label: text(item.name),
              icon:
                typeof item.icon === "function"
                  ? item.icon(this._context)
                  : item.icon,
              disabled: item.disableWhen?.(this._context) ?? false,
              run: () => this._handleItemClick(item),
            })),
        }));
      return { groups };
    },
  );

  private _bindStd() {
    const std = this._context?.std;
    if (!std || !this._mountHost) return;
    if (this._mountedStd !== std) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._mountedStd = std;
      const chrome = std.getOptional(EditorChromeHostIdentifier);
      if (chrome) {
        this._chromeUnmount = chrome.mountKeyboardPanel(
          this._mountHost,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    // The parent supplies the measured keyboard height and safe-area padding.
    Object.assign(this.style, { display: "block", boxSizing: "border-box" });
    if (!this._mountHost) {
      this._mountHost = this.ownerDocument.createElement("div");
      this._mountHost.style.display = "contents";
      this.replaceChildren(this._mountHost);
    }
    this._bindStd();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedStd = null;
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_KEYBOARD_TOOL_PANEL]: MyoxusKeyboardToolPanel;
  }
}
