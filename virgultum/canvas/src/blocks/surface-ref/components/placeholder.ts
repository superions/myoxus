import { effect, signal, untracked } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorChromeHost,
  type EditorI18nService,
  type EditorSurfaceRefPlaceholderControls,
} from "@virgultum/core/services";
import { ColorScheme } from "@virgultum/core/models";
import { NativeViewElement } from "@virgultum/core/runtime";
import { type GfxModel } from "@virgultum/core/runtime/gfx";

import { getReferenceModelTitle } from "../utils";

const TYPE_GLYPH_MAP: Record<
  string,
  EditorSurfaceRefPlaceholderControls["icon"]
> = {
  "myoxus:frame": "FrameIcon",
  group: "GroupIcon",
  mindmap: "MindmapIcon",
  edgeless: "EdgelessIcon",
};

export class SurfaceRefPlaceHolder extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _referenceModel$ = signal<GfxModel | null>(null);
  private readonly _refFlavour$ = signal("");
  private readonly _inEdgeless$ = signal(false);
  private readonly _theme$ = signal<ColorScheme>(ColorScheme.Light);
  private readonly _i18n$ = signal<EditorI18nService | undefined>(undefined);
  private readonly _chromeState$ =
    signal<EditorSurfaceRefPlaceholderControls | null>(null);
  private readonly _chromeHost$ = signal<EditorChromeHost | undefined>(
    undefined,
  );
  private _chromeUnmount?: () => void;
  private _mountedChrome?: EditorChromeHost;

  get chromeHost(): EditorChromeHost | undefined {
    return this._chromeHost$.value;
  }
  set chromeHost(value: EditorChromeHost | undefined) {
    this._chromeHost$.value = value;
  }

  get referenceModel() {
    return this._referenceModel$.value;
  }
  set referenceModel(value: GfxModel | null) {
    this._referenceModel$.value = value;
  }

  get refFlavour() {
    return this._refFlavour$.value;
  }
  set refFlavour(value: string) {
    this._refFlavour$.value = value;
  }

  get inEdgeless() {
    return this._inEdgeless$.value;
  }
  set inEdgeless(value: boolean) {
    this._inEdgeless$.value = value;
  }

  get theme() {
    return this._theme$.value;
  }
  set theme(value: ColorScheme) {
    this._theme$.value = value;
  }

  get i18n() {
    return this._i18n$.value;
  }
  set i18n(value: EditorI18nService | undefined) {
    this._i18n$.value = value;
  }

  get updateComplete() {
    return Promise.resolve(this.isConnected);
  }

  connectedCallback() {
    this._disposables.dispose();
    this._disposables = new DisposableGroup();

    const doc = this.ownerDocument;
    const names = {
      "myoxus:frame": editorMessage("com.myoxus.editor.slash.frame", "Frame"),
      group: editorMessage("com.myoxus.editor.surface-ref.group", "Group"),
      mindmap: editorMessage("com.myoxus.editor.slash.mind-map", "Mind Map"),
      edgeless: editorMessage(
        "com.myoxus.editor.surface-ref.content",
        "Edgeless content",
      ),
    };

    this._disposables.add(
      effect(() => {
        const referenceModel = this._referenceModel$.value;
        const refFlavour = this._refFlavour$.value;
        const inEdgeless = this._inEdgeless$.value;
        void this._theme$.value;
        const chrome = this._chromeHost$.value;
        const i18n = this._i18n$.value;
        void i18n?.locale$.value;

        untracked(() => {
          if (referenceModel && !inEdgeless) {
            this._chromeState$.value = null;
            if (!this._chromeUnmount) this.replaceChildren();
            return;
          }

          const text = (message: ReturnType<typeof editorMessage>) =>
            resolveEditorMessage(message, i18n);
          const modelNotFound = !referenceModel;
          const typeName = text(
            names[refFlavour as keyof typeof names] ?? names.edgeless,
          );
          const title = modelNotFound
            ? text(
                editorMessage(
                  "com.myoxus.editor.surface-ref.unavailable",
                  "{{type}} is not available",
                  { type: typeName },
                ),
              )
            : `${(referenceModel && getReferenceModelTitle(referenceModel)) ?? typeName}`;
          const description = modelNotFound
            ? text(
                editorMessage(
                  "com.myoxus.editor.surface-ref.deleted",
                  "The referenced content was deleted or is not in this document.",
                ),
              )
            : text(
                editorMessage(
                  "com.myoxus.editor.surface-ref.page-hint",
                  "This content is inserted but cannot display in Edgeless mode. Switch to Page mode to view it.",
                ),
              );

          const controls: EditorSurfaceRefPlaceholderControls = {
            notFound: modelNotFound,
            icon: modelNotFound
              ? "DeleteIcon"
              : (TYPE_GLYPH_MAP[refFlavour] ?? "EdgelessIcon"),
            title,
            description,
          };

          if (chrome?.mountSurfaceRefPlaceholder) {
            this._chromeState$.value = controls;
            if (this._mountedChrome !== chrome) {
              this._chromeUnmount?.();
              this._mountedChrome = chrome;
              const host = doc.createElement("div");
              this.replaceChildren(host);
              this._chromeUnmount = chrome.mountSurfaceRefPlaceholder(
                host,
                this._chromeState$,
              );
            }
            return;
          }

          const container = doc.createElement("div");
          container.className = modelNotFound
            ? "surface-ref-placeholder not-found"
            : "surface-ref-placeholder";
          const titleEl = doc.createElement("div");
          titleEl.className = "surface-ref-title";
          titleEl.textContent = title;
          const bodyEl = doc.createElement("div");
          bodyEl.className = "surface-ref-text";
          bodyEl.textContent = description;
          container.append(titleEl, bodyEl);
          this.replaceChildren(container);
        });
      }),
    );
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = undefined;
    this._mountedChrome = undefined;
    this._disposables.dispose();
    this.replaceChildren();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "surface-ref-placeholder": SurfaceRefPlaceHolder;
  }
}
