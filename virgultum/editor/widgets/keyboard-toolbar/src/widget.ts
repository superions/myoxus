import { effect, signal } from "@preact/signals-core";
import { getDocTitleByEditorHost } from "@virgultum/fragment-doc-title";
import { IS_MOBILE } from "@virgultum/global/env";
import type { RootBlockModel } from "@virgultum/model";
import {
  FeatureFlagService,
  isVirtualKeyboardProviderWithAction,
  VirtualKeyboardProvider,
  type VirtualKeyboardProviderWithAction,
} from "@virgultum/shared/services";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/std";
import { html, nothing } from "lit";
import { literal, unsafeStatic } from "lit/static-html.js";

import {
  defaultKeyboardToolbarConfig,
  KeyboardToolbarConfigExtension,
} from "./config.js";

export const MYOXUS_KEYBOARD_TOOLBAR_WIDGET = "myoxus-keyboard-toolbar-widget";

export class MyoxusKeyboardToolbarWidget extends WidgetComponent<RootBlockModel> {
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
  }

  override render() {
    if (
      this.store.readonly ||
      !IS_MOBILE ||
      !this.store
        .get(FeatureFlagService)
        .getFlag("enable_mobile_keyboard_toolbar")
    )
      return nothing;

    if (!this._show$.value) return nothing;

    if (!this.block?.rootComponent) return nothing;

    return html`<virgultum-portal
      .shadowDom=${false}
      .template=${html`<myoxus-keyboard-toolbar
        .keyboard=${this.keyboard}
        .config=${this.config}
        .rootComponent=${this.block.rootComponent}
      ></myoxus-keyboard-toolbar>`}
    ></virgultum-portal>`;
  }
}

export const keyboardToolbarWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_KEYBOARD_TOOLBAR_WIDGET,
  literal`${unsafeStatic(MYOXUS_KEYBOARD_TOOLBAR_WIDGET)}`,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_KEYBOARD_TOOLBAR_WIDGET]: MyoxusKeyboardToolbarWidget;
  }
}
