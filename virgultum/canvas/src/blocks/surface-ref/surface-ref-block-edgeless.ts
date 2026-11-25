import { effect, signal, untracked } from "@preact/signals-core";
import { EditorI18nProvider } from "@virgultum/core/services";
import { type SurfaceRefBlockModel } from "@virgultum/core/models";
import {
  BlockSelection,
  installEditorStyles,
  NativeBlockComponent,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type GfxModel,
} from "@virgultum/core/runtime/gfx";

import type { SurfaceRefPlaceHolder } from "./components/placeholder.js";

const edgelessSurfaceRefStyles = `
  myoxus-edgeless-surface-ref {
    position: relative;
    overflow: hidden;
  }

  .myoxus-edgeless-surface-ref-container {
    border-radius: 8px;
    border: 1px solid var(--myoxus-border-color);
    margin: 18px 0;
  }

  .myoxus-edgeless-surface-ref-container.focused {
    border-color: var(--myoxus-primary-color);
  }
`;

export class EdgelessSurfaceRefBlockComponent extends NativeBlockComponent<SurfaceRefBlockModel> {
  private readonly _referenceModel$ = signal<GfxModel | null>(null);
  private readonly _focused$ = signal(false);
  private readonly _revision$ = signal(0);

  get _referenceModel() {
    return this._referenceModel$.value;
  }
  set _referenceModel(value: GfxModel | null) {
    this._referenceModel$.value = value;
  }

  get _focused() {
    return this._focused$.value;
  }
  set _focused(value: boolean) {
    this._focused$.value = value;
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  override requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private _initSelection() {
    const selection = this.std.selection;
    this.disposables.add(
      selection.slots.changed.subscribe((selList) => {
        this._focused$.value = selList.some(
          (sel) => sel.blockId === this.blockId && sel.is(BlockSelection),
        );
      }),
    );
  }

  connectedCallback(): void {
    if (!this.connectBlock()) return;
    installEditorStyles(this, edgelessSurfaceRefStyles);

    const elementModel = this.gfx.getElementById(
      this.model.props.reference,
    ) as GfxModel;

    this._referenceModel$.value = elementModel;
    this._initSelection();

    const doc = this.ownerDocument;
    const container = doc.createElement("div");
    container.className = "myoxus-edgeless-surface-ref-container";
    const placeholder = doc.createElement(
      "surface-ref-placeholder",
    ) as SurfaceRefPlaceHolder;
    placeholder.inEdgeless = true;
    container.append(placeholder);
    this.replaceChildren(container);

    this.disposables.add(
      effect(() => {
        void this._revision$.value;
        const focused = this._focused$.value;
        const referenceModel = this._referenceModel$.value;
        const refFlavour = this.model.props.refFlavour$.value;
        untracked(() => {
          container.classList.toggle("focused", focused);
          placeholder.i18n =
            this.std.getOptional(EditorI18nProvider) ?? undefined;
          placeholder.referenceModel = referenceModel;
          placeholder.refFlavour = refFlavour;
        });
      }),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.replaceChildren();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-surface-ref": EdgelessSurfaceRefBlockComponent;
  }
}
