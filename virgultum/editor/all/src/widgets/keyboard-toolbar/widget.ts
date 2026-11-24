import { effect, signal } from "@preact/signals-core";
import { getDocTitleByEditorHost } from "@virgultum/content/title";
import { IS_MOBILE } from "@virgultum/core/primitives/env";
import type { RootBlockModel } from "@virgultum/core/models";
import {
  FeatureFlagService,
  isVirtualKeyboardProviderWithAction,
  VirtualKeyboardProvider,
  type VirtualKeyboardProviderWithAction,
} from "@virgultum/core/services";
import {
  NativeEditorWidget,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import type { MyoxusKeyboardToolbar } from "./keyboard-toolbar";

import {
  defaultKeyboardToolbarConfig,
  KeyboardToolbarConfigExtension,
} from "./config.js";

export const MYOXUS_KEYBOARD_TOOLBAR_WIDGET = "myoxus-keyboard-toolbar-widget";

export class MyoxusKeyboardToolbarWidget extends NativeEditorWidget<RootBlockModel> {
  private readonly _show$ = signal(false);

  private _initialInputMode: string = "";

  get keyboard(): VirtualKeyboardProviderWithAction & { fallback?: boolean } {
    const provider = this.std.get(VirtualKeyboardProvider);
    if (isVirtualKeyboardProviderWithAction(provider)) return provider;

    return {
      // fallback keyboard actions
      fallback: true,
      show: () => {
        const rootComponent = this.block?.rootComponent;
        if (rootComponent && rootComponent === document.activeElement) {
          rootComponent.inputMode = this._initialInputMode;
        }
      },
      hide: () => {
        const rootComponent = this.block?.rootComponent;
        if (rootComponent && rootComponent === document.activeElement) {
          rootComponent.inputMode = "none";
        }
      },
      ...provider,
    };
  }

  private get _docTitle() {
    return getDocTitleByEditorHost(this.std.host);
  }

  get config() {
    return {
      ...defaultKeyboardToolbarConfig,
      ...this.std.getOptional(KeyboardToolbarConfigExtension.identifier),
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!IS_MOBILE) return;

    this.disposables.add(
      effect(() => {
        this._show$.value = this.std.event.active$.value;
      }),
    );

    const rootComponent = this.block?.rootComponent;
    if (rootComponent && this.keyboard.fallback) {
      this._initialInputMode = rootComponent.inputMode;
      this.disposables.add(() => {
        rootComponent.inputMode = this._initialInputMode;
      });
      this.disposables.add(
        effect(() => {
          // recover input mode when keyboard toolbar is hidden
          if (!this._show$.value) {
            rootComponent.inputMode = this._initialInputMode;
          }
        }),
      );
    }

    if (this._docTitle) {
      const { inlineEditorContainer } = this._docTitle;
      this.disposables.addFromEvent(inlineEditorContainer, "focus", () => {
        this._show$.value = true;
      });
      this.disposables.addFromEvent(inlineEditorContainer, "blur", () => {
        this._show$.value = false;
      });
    }

    this.disposables.add(
      effect(() => {
        if (
          this.std.store.readonly$.value ||
          !this._show$.value ||
          !this.std.store
            .get(FeatureFlagService)
            .getFlag("enable_mobile_keyboard_toolbar")
        )
          return;
        const root = this.block?.rootComponent;
        if (!root) return;
        const toolbar = this.ownerDocument.createElement(
          "myoxus-keyboard-toolbar",
        ) as MyoxusKeyboardToolbar;
        toolbar.keyboard = this.keyboard;
        toolbar.config = this.config;
        toolbar.rootComponent = root;
        this.ownerDocument.body.append(toolbar);
        return () => toolbar.remove();
      }),
    );
  }
}

export const keyboardToolbarWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_KEYBOARD_TOOLBAR_WIDGET,
  MYOXUS_KEYBOARD_TOOLBAR_WIDGET,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_KEYBOARD_TOOLBAR_WIDGET]: MyoxusKeyboardToolbarWidget;
  }
}
