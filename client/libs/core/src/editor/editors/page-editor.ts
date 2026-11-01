import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { noop } from "@virgultum/editor/global/utils";
import {
  DocModeProvider,
  ThemeProvider,
} from "@virgultum/editor/shared/services";
import {
  BlockStdScope,
  EditorHost,
  ShadowlessElement,
} from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { guard } from "lit/directives/guard.js";

noop(EditorHost);

export class PageEditor extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    page-editor {
      font-family: var(--myoxus-font-family);
      background: var(--myoxus-background-primary-color);
    }

    page-editor * {
      box-sizing: border-box;
    }

    @media print {
      page-editor {
        height: auto;
      }
    }

    .myoxus-page-viewport {
      position: relative;
      height: 100%;
      overflow-x: hidden;
      overflow-y: auto;
      container-name: viewport;
      container-type: inline-size;
    }

    .page-editor-container {
      display: block;
      height: 100%;
    }
  `;

  get host() {
    try {
      return this.std.host;
    } catch {
      return null;
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this._disposables.add(
      this.doc.slots.rootAdded.subscribe(() => this.requestUpdate()),
    );
    this.std = new BlockStdScope({
      store: this.doc,
      extensions: this._buildExtensions(),
    });
    // P-VIRG-ARCH-H-02-Slice-2: wire the editor-mode
    // resolver onto the GfxController so that
    // `_safeExecute` (which lives below the runtime
    // layer in `MoveInteractionManager` and friends)
    // can stamp `[page::operation]` /
    // `[edgeless::operation]` onto its structured
    // log lines. The host (this wrapper) is the only
    // place that knows the `DocModeProvider`, so the
    // wiring has to happen here.
    this._wireGfxModeResolver();
  }

  override async getUpdateComplete(): Promise<boolean> {
    const result = await super.getUpdateComplete();
    await this.host?.updateComplete;
    return result;
  }

  override render() {
    if (!this.doc.root) return nothing;

    const std = this.std;
    const theme = std.get(ThemeProvider).app$.value;
    return html`
      <div data-theme=${theme} class="page-editor-container">
        ${guard([std], () => std.render())}
      </div>
    `;
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);
    if (
      this.hasUpdated && // skip the first update
      (changedProperties.has("doc") || changedProperties.has("hostExtension"))
    ) {
      this.std = new BlockStdScope({
        store: this.doc,
        extensions: this._buildExtensions(),
      });
      // P-VIRG-ARCH-H-02-Slice-2: re-wire the resolver
      // after a `BlockStdScope` rebuild (the
      // `GfxController` instance is fresh).
      this._wireGfxModeResolver();
    }
  }

  /**
   * Merge the spec list with the optional `hostExtension` that
   * carries the `MyoxusHostService` binding. The host extension is
   * supplied by the Myoxus-Core React wrapper (`lit-adaper.tsx`).
   * If a host extension is not provided we fall back to the
   * `NullMyoxusHostService` registered by the default extension
   * chain so consumers can still call `std.get(...)` without
   * crashes. Tests can supply their own.
   */
  private _buildExtensions(): ExtensionType[] {
    return this.hostExtension
      ? [...this.specs, this.hostExtension]
      : this.specs;
  }

  /**
   * P-VIRG-ARCH-H-02-Slice-2: bind the host-injected
   * `DocModeProvider` onto the `GfxController` so the
   * GFX interactivity sub-managers can stamp the
   * current editor mode into `_safeExecute` log
   * lines.
   *
   * The `GfxController` is registered as a
   * `BlockStdScope` internal extension, so it is
   * always available via `std.get(GfxControllerIdentifier)`.
   * The `DocModeProvider` is supplied by the host
   * extension list (`MyoxusHostExtension` /
   * `DocModeExtension`) and may not be present in
   * early-boot or test setups; in that case we leave
   * the resolver unset and the formatter falls back
   * to the `?` sentinel (P-VIRG-ARCH-H-02-Slice-1
   * contract).
   *
   * Idempotent: re-calling with the same resolver
   * is cheap; the `setModeResolver` implementation
   * overwrites the previous resolver.
   */
  private _wireGfxModeResolver(): void {
    const gfx = this.std.getOptional(GfxControllerIdentifier);
    if (!gfx) {
      return;
    }
    const provider = this.std.getOptional(DocModeProvider);
    if (!provider) {
      // No mode provider in this scope; clear any
      // previous wiring so we don't keep a stale
      // closure around after a scope rebuild.
      gfx.setModeResolver(null);
      return;
    }
    gfx.setModeResolver(() => provider.getEditorMode());
  }

  @property({ attribute: false })
  accessor doc!: Store;

  @property({ attribute: false })
  accessor hostExtension: ExtensionType | undefined = undefined;

  @property({ attribute: false })
  accessor specs: ExtensionType[] = [];

  @state()
  accessor std!: BlockStdScope;
}

declare global {
  interface HTMLElementTagNameMap {
    "page-editor": PageEditor;
  }
}
