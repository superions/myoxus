// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, effect, signal } from "@preact/signals-core";
import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import {
  StoreExtensionManager,
  type ViewExtensionContext,
  ViewExtensionManager,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { getInternalStoreExtensions } from "@virgultum/editor/extensions/store";
import { getInternalViewExtensions } from "@virgultum/editor/extensions/view";
import type { DocTitle } from "@virgultum/editor/fragments/doc-title";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
import type { DocMode } from "@virgultum/editor/model";
import {
  DocEmbedProvider,
  ThemeProvider,
} from "@virgultum/editor/shared/services";
import { BlockStdScope, NativeViewElement } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { BlockModel, ExtensionType, Store } from "@virgultum/editor/store";

import { mountEditorChrome } from "../chrome-host.js";

const CONTAINER_TAG = "myoxus-editor-container";

const HOST_VIEWPORT_CSS = `
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
  .integration-page-editor-container {
    flex-grow: 1;
    font-family: var(--myoxus-font-family);
    display: block;
  }
  .integration-page-editor-container * {
    box-sizing: border-box;
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
  .myoxus-edgeless-viewport {
    display: block;
    height: 100%;
    position: relative;
    overflow: clip;
    container-name: viewport;
    container-type: inline-size;
  }
  @media print {
    .myoxus-page-viewport,
    .integration-page-editor-container,
    .edgeless-editor-container {
      height: auto;
    }
  }
`;

const sharedStoreManager = new StoreExtensionManager(
  getInternalStoreExtensions(),
);

export function getTestStoreManager(): StoreExtensionManager {
  return sharedStoreManager;
}

/** Propagates the harness chrome extension into nested preview view scopes. */
export class TestChromeViewExtension extends ViewExtensionProvider<{
  extension: ExtensionType;
}> {
  override name = "TestChrome";

  override setup(
    context: ViewExtensionContext,
    options?: { extension: ExtensionType },
  ): void {
    super.setup(context, options);
    if (options) {
      context.register(options.extension);
    }
  }
}

export function createTestViewManager(): ViewExtensionManager {
  return new ViewExtensionManager([
    ...getInternalViewExtensions(),
    TestChromeViewExtension,
  ]);
}

/**
 * Custom element (`<myoxus-editor-container>`) backing both Vitest browser
 * fixtures and the Playwright Virgultum E2E harness.
 */
export class TestMyoxusEditorContainer extends NativeViewElement {
  private disposables = new DisposableGroup();
  private readonly viewport = document.createElement("div");
  private activePaint: Promise<void> = Promise.resolve();
  private readonly rootVersion = signal(0);
  private initialPaint = true;

  private readonly docSignal = signal<Store>();
  private readonly modeSignal = signal<DocMode>("page");
  private readonly pageSpecsSignal = signal<ExtensionType[]>([]);
  private readonly edgelessSpecsSignal = signal<ExtensionType[]>([]);
  private readonly chromeExtensionsSignal = signal<ExtensionType[]>([]);
  private readonly chromeReadyResolver = Promise.withResolvers<void>();

  readonly viewManager = createTestViewManager();

  private readonly activeSpecs = computed(() =>
    this.modeSignal.value === "page"
      ? this.pageSpecsSignal.value
      : this.edgelessSpecsSignal.value,
  );

  private readonly stdScope = computed(
    () =>
      new BlockStdScope({
        store: this.doc,
        extensions: [
          ...this.activeSpecs.value,
          ...this.chromeExtensionsSignal.value,
        ],
      }),
  );

  private readonly renderedHost = computed(() => {
    const std = this.stdScope.value;
    std.getOptional(GfxControllerIdentifier)?.setModeResolver(() => this.mode);
    return std.render();
  });

  get chromeReady(): Promise<void> {
    return this.chromeReadyResolver.promise;
  }

  get updateComplete(): Promise<void> {
    return this.chromeReady.then(() => this.activePaint);
  }

  get doc(): Store {
    return this.docSignal.value as Store;
  }

  set doc(next: Store) {
    this.docSignal.value = next;
  }

  get mode(): DocMode {
    return this.modeSignal.value;
  }

  set mode(next: DocMode) {
    this.modeSignal.value = next;
  }

  get pageSpecs(): ExtensionType[] {
    return this.pageSpecsSignal.value;
  }

  set pageSpecs(specs: ExtensionType[]) {
    this.pageSpecsSignal.value = specs;
  }

  get edgelessSpecs(): ExtensionType[] {
    return this.edgelessSpecsSignal.value;
  }

  set edgelessSpecs(specs: ExtensionType[]) {
    this.edgelessSpecsSignal.value = specs;
  }

  get rootModel(): BlockModel {
    return this.doc.root as BlockModel;
  }

  get std(): BlockStdScope {
    return this.stdScope.value;
  }

  get host() {
    try {
      return this.std.host;
    } catch {
      return null;
    }
  }

  switchEditor(mode: DocMode): void {
    this.modeSignal.value = mode;
  }

  connectedCallback(): void {
    this.disposables = new DisposableGroup();
    const styleEl = document.createElement("style");
    styleEl.textContent = HOST_VIEWPORT_CSS;
    this.replaceChildren(styleEl, this.viewport);

    const workspace = this.doc.workspace;
    const docsVersion = signal(0);
    this.disposables.add(
      workspace.slots.docListUpdated.subscribe(() => {
        docsVersion.value += 1;
      }),
    );

    const isKnownLocalDoc = (id: string) =>
      Boolean(workspace.getDoc(id) && workspace.meta.getDocMeta(id));

    // Single authoritative local-workspace access boundary for nested embeds.
    const embedAccess: DocEmbedProvider = {
      inWorkspace: (workspaceId) =>
        workspaceId === workspace.id
          ? { access: embedAccess, collection: workspace, dispose: () => {} }
          : undefined,
      openReference: (workspaceId, docId) => ({
        target: computed(() => {
          void docsVersion.value;
          return (workspaceId === undefined || workspaceId === workspace.id) &&
            isKnownLocalDoc(docId)
            ? { access: embedAccess, collection: workspace, docId }
            : null;
        }),
        dispose: () => {},
      }),
      canRead: async (docId) => isKnownLocalDoc(docId),
      readable: (docId) =>
        computed(() => {
          void docsVersion.value;
          return isKnownLocalDoc(docId);
        }),
      waitForLoaded: async (docId, abort) => {
        abort.throwIfAborted();
        if (!isKnownLocalDoc(docId)) {
          throw new Error("Unknown fixture document");
        }
        const target = workspace.getDoc(docId)!;
        target.load();
        abort.throwIfAborted();
        if (!target.ready) {
          throw new Error("Fixture document is not ready");
        }
      },
    };

    this.disposables.add(
      mountEditorChrome(this, (chrome) => {
        const chromeWithEmbed: ExtensionType = {
          setup: (di) => {
            chrome.setup(di);
            di.override(DocEmbedProvider, () => embedAccess);
          },
        };
        this.viewManager.configure(TestChromeViewExtension, {
          extension: chromeWithEmbed,
        });
        this.chromeExtensionsSignal.value = [
          chromeWithEmbed,
          {
            // Keep nested preview scopes bound to this container's viewManager
            // when tests instantiate multiple editors simultaneously.
            setup: (di) => {
              di.override(
                ViewExtensionManagerIdentifier,
                () => this.viewManager,
              );
            },
          },
        ];
        this.chromeReadyResolver.resolve();
      }),
    );

    this.disposables.add(
      effect(() => {
        const sub = this.doc.slots.rootAdded.subscribe(() => {
          this.rootVersion.value += 1;
        });
        return () => sub.unsubscribe();
      }),
    );

    this.disposables.add(
      effect(() => {
        void this.rootVersion.value;
        if (!this.chromeExtensionsSignal.value.length || !this.doc.root) {
          this.activePaint = Promise.resolve();
          this.viewport.replaceChildren();
          return;
        }

        const isPage = this.mode === "page";
        const theme = this.std.get(ThemeProvider);
        const themeMode = (isPage ? theme.app$ : theme.edgeless$).value;
        const hostEl = this.renderedHost.value;
        const currentDoc = this.doc;

        const paintPromise = Promise.resolve().then(() => {
          if (!this.isConnected || this.activePaint !== paintPromise) return;
          this.viewport.dataset.theme = themeMode;
          if (this.viewport.contains(hostEl)) return;

          this.viewport.className = isPage
            ? "myoxus-page-viewport"
            : "myoxus-edgeless-viewport";

          const editorWrapper = document.createElement("div");
          editorWrapper.className = isPage
            ? "page-editor integration-page-editor-container"
            : "edgeless-editor-container";

          if (isPage) {
            const titleEl = document.createElement("doc-title") as DocTitle;
            titleEl.doc = currentDoc;
            this.viewport.replaceChildren(titleEl, editorWrapper);
          } else {
            this.viewport.replaceChildren(editorWrapper);
          }
          editorWrapper.append(hostEl);

          if (this.initialPaint && isPage && this.autofocus) {
            setTimeout(() => {
              if (hostEl.isConnected && this.mode === "page") {
                this.querySelector("rich-text")?.inlineEditor?.focusEnd();
              }
            });
          }
          this.initialPaint = false;
        });

        this.activePaint = paintPromise;
      }),
    );
  }

  disconnectedCallback(): void {
    this.disposables.dispose();
    this.viewport.replaceChildren();
    this.chromeExtensionsSignal.value = [];
  }
}

export function registerTestEditorHost(): void {
  if (!customElements.get(CONTAINER_TAG)) {
    customElements.define(CONTAINER_TAG, TestMyoxusEditorContainer);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [CONTAINER_TAG]: TestMyoxusEditorContainer;
  }
}
