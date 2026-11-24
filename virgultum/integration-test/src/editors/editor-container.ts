import { getTestViewManager, TestChromeViewExtension } from "../view";
import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import { mountEditorChrome } from "../chrome-host";
import { computed, effect, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import type { DocTitle } from "@virgultum/editor/fragments/doc-title";
import type { DocMode } from "@virgultum/editor/model";
import {
  DocEmbedProvider,
  ThemeProvider,
} from "@virgultum/editor/shared/services";
import { BlockStdScope, NativeViewElement } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import {
  type BlockModel,
  type ExtensionType,
  type Store,
} from "@virgultum/editor/store";
const viewportStyles = `
    .myoxus-page-viewport {
      position: relative;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      overflow-y: auto;
      container-name: viewport;
      container-type: inline-size;
      font-family: var(--myoxus-font-family);
    }
    .myoxus-page-viewport * {
      box-sizing: border-box;
    }

    @media print {
      .myoxus-page-viewport {
        height: auto;
      }
    }

    .integration-page-editor-container {
      flex-grow: 1;
      font-family: var(--myoxus-font-family);
      display: block;
    }

    .integration-page-editor-container * {
      box-sizing: border-box;
    }

    @media print {
      .integration-page-editor-container {
        height: auto;
      }
    }

    .edgeless-editor-container {
      font-family: var(--myoxus-font-family);
      background: var(--myoxus-background-primary-color);
      display: block;
      height: 100%;
      position: relative;
      overflow: clip;
    }

    .edgeless-editor-container * {
      box-sizing: border-box;
    }

    @media print {
      .edgeless-editor-container {
        height: auto;
      }
    }

    .myoxus-edgeless-viewport {
      display: block;
      height: 100%;
      position: relative;
      overflow: clip;
      container-name: viewport;
      container-type: inline-size;
    }
`;

export class TestMyoxusEditorContainer extends NativeViewElement {
  private disposables = new DisposableGroup();
  private viewport = document.createElement("div");
  private pendingPaint: Promise<void> = Promise.resolve();
  private rootRevision = signal(0);
  private firstPaint = true;

  get updateComplete() {
    return this.chromeReady.then(() => this.pendingPaint);
  }

  private readonly _doc = signal<Store>();

  private readonly _edgelessSpecs = signal<ExtensionType[]>([]);

  private readonly _mode = signal<DocMode>("page");

  private readonly _pageSpecs = signal<ExtensionType[]>([]);

  private readonly _specs = computed(() =>
    this._mode.value === "page"
      ? this._pageSpecs.value
      : this._edgelessSpecs.value,
  );

  readonly viewManager = getTestViewManager();

  private readonly chromeExtensions = signal<ExtensionType[]>([]);

  private readonly chromeReadyState = Promise.withResolvers<void>();

  get chromeReady() {
    return this.chromeReadyState.promise;
  }

  private readonly _std = computed(() => {
    return new BlockStdScope({
      store: this.doc,
      extensions: [...this._specs.value, ...this.chromeExtensions.value],
    });
  });

  private readonly editorHost = computed(() => {
    const std = this._std.value;
    // Match PageEditor/EdgelessEditor: native diagram gestures consume the
    // current scope's GFX mode, rather than guessing it from a DOM ancestor.
    std.getOptional(GfxControllerIdentifier)?.setModeResolver(() => this.mode);
    return std.render();
  });

  get doc() {
    return this._doc.value as Store;
  }

  set doc(doc: Store) {
    this._doc.value = doc;
  }

  set edgelessSpecs(specs: ExtensionType[]) {
    this._edgelessSpecs.value = specs;
  }

  get edgelessSpecs() {
    return this._edgelessSpecs.value;
  }

  get host() {
    try {
      return this.std.host;
    } catch {
      return null;
    }
  }

  get mode() {
    return this._mode.value;
  }

  set mode(mode: DocMode) {
    this._mode.value = mode;
  }

  set pageSpecs(specs: ExtensionType[]) {
    this._pageSpecs.value = specs;
  }

  get pageSpecs() {
    return this._pageSpecs.value;
  }

  get rootModel() {
    return this.doc.root as BlockModel;
  }

  get std() {
    return this._std.value;
  }

  connectedCallback() {
    this.disposables = new DisposableGroup();
    const style = document.createElement("style");
    style.textContent = viewportStyles;
    this.replaceChildren(style, this.viewport);
    const workspace = this.doc.workspace;
    const documentsRevision = signal(0);
    this.disposables.add(
      workspace.slots.docListUpdated.subscribe(() => documentsRevision.value++),
    );
    // The standalone fixture host owns its local documents. Exercise the same
    // access boundary as Web; unknown and foreign documents receive no grant.
    const access: DocEmbedProvider = {
      inWorkspace: (id) =>
        id === workspace.id
          ? { access, collection: workspace, dispose: () => {} }
          : undefined,
      openReference: (id, docId) => ({
        target: computed(() => {
          void documentsRevision.value;
          return (id === undefined || id === workspace.id) &&
            workspace.getDoc(docId)
            ? { access, collection: workspace, docId }
            : null;
        }),
        dispose: () => {},
      }),
      canRead: async (id) => !!workspace.getDoc(id),
      readable: (id) =>
        computed(() => {
          void documentsRevision.value;
          return !!workspace.getDoc(id);
        }),
      waitForLoaded: async (id, abort) => {
        abort.throwIfAborted();
        const target = workspace.getDoc(id);
        if (!target) throw new Error("Unknown fixture document");
        target.load();
        if (!target.ready) throw new Error("Fixture document is not ready");
      },
    };
    this.disposables.add(
      mountEditorChrome(this, (chrome) => {
        const extension: ExtensionType = {
          setup: (di) => {
            chrome.setup(di);
            di.override(DocEmbedProvider, () => access);
          },
        };
        this.viewManager.configure(TestChromeViewExtension, { extension });
        this.chromeExtensions.value = [
          extension,
          {
            // A second test editor may inherit specs; its previews still belong
            // to its own React portal host and must not reuse the first editor's.
            setup: (di) =>
              di.override(
                ViewExtensionManagerIdentifier,
                () => this.viewManager,
              ),
          },
        ];
        this.chromeReadyState.resolve();
      }),
    );

    this.disposables.add(
      effect(() => {
        const sub = this.doc.slots.rootAdded.subscribe(
          () => this.rootRevision.value++,
        );
        return () => sub.unsubscribe();
      }),
    );
    this.disposables.add(
      effect(() => {
        void this.rootRevision.value;
        if (!this.chromeExtensions.value.length || !this.doc.root) {
          this.pendingPaint = Promise.resolve();
          this.viewport.replaceChildren();
          return;
        }
        const page = this.mode === "page";
        const theme = this.std.get(ThemeProvider);
        const color = (page ? theme.app$ : theme.edgeless$).value;
        const host = this.editorHost.value;
        const doc = this.doc;
        // Batch synchronous spec, mode and document changes before mounting the scope.
        const paint = Promise.resolve().then(() => {
          if (!this.isConnected || this.pendingPaint !== paint) return;
          this.viewport.dataset.theme = color;
          if (this.viewport.contains(host)) return;
          this.viewport.className = page
            ? "myoxus-page-viewport"
            : "myoxus-edgeless-viewport";
          const container = document.createElement("div");
          container.className = page
            ? "page-editor integration-page-editor-container"
            : "edgeless-editor-container";
          if (page) {
            const title = document.createElement("doc-title") as DocTitle;
            title.doc = doc;
            this.viewport.replaceChildren(title, container);
          } else {
            this.viewport.replaceChildren(container);
          }
          container.append(host);
          if (this.firstPaint && page && this.autofocus) {
            setTimeout(() => {
              if (host.isConnected && this.mode === "page")
                this.querySelector("rich-text")?.inlineEditor?.focusEnd();
            });
          }
          this.firstPaint = false;
        });
        this.pendingPaint = paint;
      }),
    );
  }

  disconnectedCallback() {
    this.disposables.dispose();
    this.viewport.replaceChildren();
    this.chromeExtensions.value = [];
  }

  switchEditor(mode: DocMode) {
    this._mode.value = mode;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-editor-container": TestMyoxusEditorContainer;
  }
}
