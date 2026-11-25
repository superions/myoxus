import { computed, effect, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  installEditorStyles,
  NativeViewElement,
} from "@virgultum/core/runtime";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import type { EmbedHtmlBlockComponent } from "../embed-html-block.js";

// Fullscreen anchoring and the existing hover-reveal hit area are technical geometry.
const fullscreenToolbarStyles = `
  embed-html-fullscreen-toolbar {
    position: absolute;
    z-index: 1;
    left: 50%;
    transform: translateX(-50%);
    bottom: 0;
    user-select: none;
  }
  embed-html-fullscreen-toolbar .toolbar-toggle-control {
    padding-bottom: 20px;
  }
  embed-html-fullscreen-toolbar
    .toolbar-toggle-control[data-auto-hide="true"] {
    transition: 0.27s ease;
    padding-top: 100px;
    transform: translateY(100px);
  }
  embed-html-fullscreen-toolbar
    .toolbar-toggle-control[data-auto-hide="true"]:hover {
    padding-top: 0;
    transform: translateY(0);
  }
`;

export class EmbedHtmlFullscreenToolbar extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private copyTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly _copied$ = signal(false);
  private readonly _popperVisible$ = signal(false);
  private readonly _autoHideTick$ = signal(0);

  embedHtml!: EmbedHtmlBlockComponent;

  copyCode = () => {
    if (this._copied$.peek()) return;
    this.embedHtml.std.clipboard
      .writeToClipboard((items) => ({
        ...items,
        "text/plain": this.embedHtml.model.props.html ?? "",
      }))
      .then(() => {
        if (!this.isConnected) return;
        this._copied$.value = true;
        this.copyTimeout = setTimeout(() => {
          this._copied$.value = false;
        }, 1500);
      })
      .catch(console.error);
  };

  private get autoHideToolbar() {
    void this._autoHideTick$.value;
    return (
      this.embedHtml.std
        .get(EditPropsStore)
        .getStorage("autoHideEmbedHTMLFullScreenToolbar") ?? false
    );
  }
  private set autoHideToolbar(value: boolean) {
    this.embedHtml.std
      .get(EditPropsStore)
      .setStorage("autoHideEmbedHTMLFullScreenToolbar", value);
    this._autoHideTick$.value++;
  }

  connectedCallback() {
    installEditorStyles(this, fullscreenToolbarStyles);
    this._disposables.dispose();
    this._disposables = new DisposableGroup();

    const doc = this.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "toolbar-toggle-control";
    const host = doc.createElement("div");
    host.style.display = "contents";
    wrapper.append(host);
    this.replaceChildren(wrapper);

    this._disposables.add(
      effect(() => {
        wrapper.dataset.autoHide = String(
          !this._popperVisible$.value && this.autoHideToolbar,
        );
      }),
    );

    const chrome = this.embedHtml?.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;

    const state$ = computed(() => ({
      copied: this._copied$.value,
      autoHide: this.autoHideToolbar,
      settingsOpen: this._popperVisible$.value,
      setSettingsOpen: (value: boolean) => {
        this._popperVisible$.value = value;
      },
      setAutoHide: (value: boolean) => {
        this.autoHideToolbar = value;
      },
      close: () => {
        this._popperVisible$.value = false;
        this.embedHtml.close();
      },
      copy: this.copyCode,
    }));

    const unmount = chrome.mountHtmlFullscreenToolbar(host, state$);
    this._disposables.add(() => {
      unmount();
      host.remove();
    });
  }

  disconnectedCallback() {
    clearTimeout(this.copyTimeout);
    this._copied$.value = false;
    this._disposables.dispose();
  }
}
