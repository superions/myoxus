import { effect, signal, untracked } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "@virgultum/core/services";
import { DeleteIcon } from "@myoxus/icons/native";
import { ColorScheme } from "@virgultum/core/models";
import {
  installEditorStyles,
  NativeViewElement,
} from "@virgultum/core/runtime";
import { type GfxModel } from "@virgultum/core/runtime/gfx";

import { DarkDeletedSmallBanner, LightDeletedSmallBanner } from "../icons";
import { getReferenceModelTitle, TYPE_ICON_MAP } from "../utils";

const placeholderStyles = `
  .surface-ref-placeholder {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }

  .surface-ref-placeholder.not-found {
    background: var(--myoxus-background-secondary-color);
  }

  .surface-ref-placeholder-heading {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    align-self: stretch;

    font-size: 14px;
    font-weight: 500;
    line-height: 22px;

    text-overflow: ellipsis;
    white-space: nowrap;
    overflow: hidden;

    color: var(--myoxus-text-primary-color);
  }

  .surface-ref-placeholder-body {
    position: relative;
    font-size: 12px;
    font-weight: 400;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
    overflow: hidden;
    color: var(--myoxus-text-disable-color);
  }

  .surface-ref-not-found-background {
    position: absolute;
    right: 12px;
    bottom: -5px;
  }
`;

function parseSvg(doc: Document, markup: string) {
  const tpl = doc.createElement("template");
  tpl.innerHTML = markup;
  return tpl.content.firstElementChild;
}

export class SurfaceRefPlaceHolder extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private readonly _referenceModel$ = signal<GfxModel | null>(null);
  private readonly _refFlavour$ = signal("");
  private readonly _inEdgeless$ = signal(false);
  private readonly _theme$ = signal<ColorScheme>(ColorScheme.Light);
  private readonly _i18n$ = signal<EditorI18nService | undefined>(undefined);

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
    installEditorStyles(this, placeholderStyles);
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
        const theme = this._theme$.value;
        const i18n = this._i18n$.value;
        void i18n?.locale$.value;

        untracked(() => {
          // When surface ref is in page mode and reference exists, don't render placeholder
          if (referenceModel && !inEdgeless) {
            this.replaceChildren();
            return;
          }

          const text = (message: ReturnType<typeof editorMessage>) =>
            resolveEditorMessage(message, i18n);
          const modelNotFound = !referenceModel;
          const matchedType =
            TYPE_ICON_MAP[refFlavour] ?? TYPE_ICON_MAP["edgeless"];
          const typeName = text(
            names[refFlavour as keyof typeof names] ?? names.edgeless,
          );
          const title =
            (referenceModel && getReferenceModelTitle(referenceModel)) ??
            typeName;

          const container = doc.createElement("div");
          container.className = modelNotFound
            ? "surface-ref-placeholder not-found"
            : "surface-ref-placeholder";

          if (modelNotFound) {
            const bg = doc.createElement("div");
            bg.className = "surface-ref-not-found-background";
            const banner = parseSvg(
              doc,
              theme === ColorScheme.Light
                ? LightDeletedSmallBanner
                : DarkDeletedSmallBanner,
            );
            if (banner) bg.append(banner);
            container.append(bg);
          }

          const heading = doc.createElement("div");
          heading.className = "surface-ref-placeholder-heading";
          const iconEl = parseSvg(
            doc,
            modelNotFound ? DeleteIcon : matchedType.icon,
          );
          if (iconEl) heading.append(iconEl);

          const titleSpan = doc.createElement("span");
          titleSpan.className = "surface-ref-title";
          titleSpan.textContent = modelNotFound
            ? text(
                editorMessage(
                  "com.myoxus.editor.surface-ref.unavailable",
                  "{{type}} is not available",
                  { type: typeName },
                ),
              )
            : `${title}`;
          heading.append(titleSpan);

          const body = doc.createElement("div");
          body.className = "surface-ref-placeholder-body";
          const bodySpan = doc.createElement("span");
          bodySpan.className = "surface-ref-text";
          bodySpan.textContent = modelNotFound
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
          body.append(bodySpan);

          container.append(heading, body);
          this.replaceChildren(container);
        });
      }),
    );
  }

  disconnectedCallback() {
    this._disposables.dispose();
    this.replaceChildren();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "surface-ref-placeholder": SurfaceRefPlaceHolder;
  }
}
