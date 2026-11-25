/* oxlint-disable typescript/no-non-null-assertion */
import {
  DefaultTool,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/canvas-runtime/surface";
import type { RootBlockModel } from "@virgultum/core/models";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  type EditorCanvasToolbarControls,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { stopPropagation } from "@virgultum/core/utils";
import {
  NativeEditorWidget,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { signal } from "@preact/signals-core";

import {
  QuickToolIdentifier,
  SeniorToolIdentifier,
} from "./extension/index.js";

export interface CanvasToolPopper {
  element: HTMLElement;
  dispose: () => void;
}

const toolbarGeometry = `
/* Canvas anchoring and presentation auto-hide remain technical geometry. */
edgeless-toolbar-widget {
  position: absolute;
  z-index: 1;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: 100%;
  pointer-events: none;
}
edgeless-toolbar-widget > .edgeless-toolbar-wrapper {
  display: flex;
  justify-content: center;
}
edgeless-toolbar-widget .edgeless-toolbar-toggle-control {
  /* The dock's empty inset must not intercept canvas content. */
  pointer-events: none;
  padding-bottom: 16px;
  max-width: calc(100% - 128px);
}
edgeless-toolbar-widget
  .edgeless-toolbar-toggle-control
  [role="toolbar"] {
  pointer-events: auto;
}
edgeless-toolbar-widget
  .edgeless-toolbar-toggle-control[data-enable="true"] {
  pointer-events: auto;
  transition: 0.23s ease;
  padding-top: 100px;
  transform: translateY(100px);
}
edgeless-toolbar-widget
  .edgeless-toolbar-toggle-control[data-enable="true"]:hover,
edgeless-toolbar-widget
  .edgeless-toolbar-toggle-control[data-enable="true"]:focus-within {
  padding-top: 0;
  transform: translateY(0);
}
edgeless-toolbar-widget[disabled] .edgeless-toolbar-container {
  pointer-events: none;
}
`;

export const EDGELESS_TOOLBAR_WIDGET = "edgeless-toolbar-widget";
export class EdgelessToolbarWidget extends NativeEditorWidget<RootBlockModel> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  private readonly controls = signal<EditorCanvasToolbarControls | null>(null);
  private readonly anchor = document.createElement("div");
  private setContainer = (element: HTMLDivElement | null) => {
    if (element && this.toolbarContainer !== element) {
      this.toolbarContainer = element;
      this.requestUpdate();
    }
  };

  activePopper: CanvasToolPopper | null = null;

  private get _cachedPresentHideToolbar() {
    return !!this.std.get(EditPropsStore).getStorage("presentHideToolbar");
  }

  /**
   * When enabled, the toolbar auto-hides until hovered or focused.
   */
  private get _enableAutoHide() {
    return (
      this.isPresentMode &&
      this._cachedPresentHideToolbar &&
      !this.presentSettingMenuShow &&
      !this.presentFrameMenuShow
    );
  }

  private get _quickTools() {
    const block = this.block;
    if (!block) {
      return [];
    }
    const quickTools = Array.from(
      this.std.provider.getAll(QuickToolIdentifier).values(),
    );
    const gfx = this.std.get(GfxControllerIdentifier);
    return quickTools
      .map((tool) =>
        tool({ block, gfx, toolbarContainer: this.toolbarContainer }),
      )
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .filter(({ enable = true }) => enable);
  }

  private get _seniorTools() {
    const block = this.block;
    if (!block) {
      return [];
    }
    const seniorTools = Array.from(
      this.std.provider.getAll(SeniorToolIdentifier).values(),
    );
    const gfx = this.std.get(GfxControllerIdentifier);
    return seniorTools
      .map((tool) =>
        tool({ block, gfx, toolbarContainer: this.toolbarContainer }),
      )
      .filter(({ enable = true }) => enable);
  }

  get edgelessTool() {
    return this.gfx.tool.currentToolName$.value;
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get isPresentMode() {
    return this.edgelessTool === "frameNavigator";
  }

  private toolbarControls(): EditorCanvasToolbarControls {
    return {
      setContainer: this.setContainer,
      quick: this._quickTools.map((tool) => ({
        ...tool.content,
        menu: tool.menu,
      })),
      senior: this._seniorTools.map((tool) => tool.content),
      moreLabel: this._text(
        editorMessage("com.myoxus.editor.toolbar.more-tools", "More tools"),
      ),
      navigation: [],
      presentation:
        this.isPresentMode && this.block
          ? {
              edgeless: this.block,
              settingMenuShow: this.presentSettingMenuShow,
              frameMenuShow: this.presentFrameMenuShow,
              setSettingMenuShow: (show) => {
                this.presentSettingMenuShow = show;
                this.requestUpdate();
              },
              setFrameMenuShow: (show) => {
                this.presentFrameMenuShow = show;
                this.requestUpdate();
              },
            }
          : undefined,
    };
  }

  override connectedCallback() {
    super.connectedCallback();
    const style = document.createElement("style");
    style.textContent = toolbarGeometry;
    const wrapper = document.createElement("div");
    wrapper.className = "edgeless-toolbar-wrapper";
    this.anchor.className = "edgeless-toolbar-toggle-control";
    for (const event of ["dblclick", "mousedown", "pointerdown"]) {
      this.anchor.addEventListener(event, stopPropagation);
      this.disposables.add(() =>
        this.anchor.removeEventListener(event, stopPropagation),
      );
    }
    wrapper.append(this.anchor);
    this.replaceChildren(style, wrapper);
    this.disposables.add(
      this.std
        .get(EditorChromeHostIdentifier)
        .mountCanvasToolbar(this.anchor, this.controls),
    );
    this.disposables.add(
      this.gfx.tool.currentToolName$.subscribe((name) => {
        if (
          (name === "default" || name === "pan") &&
          localStorage.defaultTool !== name
        )
          localStorage.defaultTool = name;
        this.requestUpdate();
      }),
    );
    this.disposables.add(
      this.std.store.readonly$.subscribe(() => this.requestUpdate()),
    );
    this.observeToolbar();
    if (!this.block) return;
    this.disposables.add(
      this.block.bindHotKey(
        {
          Escape: () => {
            if (this.gfx.selection.editing) return;
            if (this.edgelessTool === "frameNavigator") return;
            if (this.activePopper) {
              this.activePopper.dispose();
              this.activePopper = null;
            }
            if (this.edgelessTool !== "default") {
              this.gfx.tool.setTool(DefaultTool);
            }
          },
        },
        { global: true },
      ),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.controls.value = null;
    this.activePopper?.dispose();
    this.activePopper = null;
  }

  private observeToolbar() {
    const { disposables, gfx } = this;

    const slots = this.std.get(EdgelessLegacySlotIdentifier);
    const editPropsStore = this.std.get(EditPropsStore);

    disposables.add(
      gfx.viewport.viewportUpdated.subscribe(() => this.requestUpdate()),
    );
    disposables.add(
      slots.readonlyUpdated.subscribe(() => {
        this.requestUpdate();
      }),
    );
    disposables.add(
      slots.toolbarLocked.subscribe((disabled) => {
        this.toggleAttribute("disabled", disabled);
      }),
    );
    disposables.add(
      editPropsStore.slots.storageUpdated.subscribe(({ key }) => {
        if (key === "presentHideToolbar") {
          this.requestUpdate();
        }
      }),
    );
  }

  private pending = false;
  private requestUpdate() {
    if (this.pending || !this.isConnected) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.isConnected) return;
      this.anchor.dataset.enable = String(this._enableAutoHide);
      this.controls.value =
        this.std.store.readonly && !this.isPresentMode
          ? null
          : this.toolbarControls();
    });
  }

  private presentFrameMenuShow = false;

  private presentSettingMenuShow = false;

  toolbarContainer!: HTMLElement;
}

export const edgelessToolbarWidget = WidgetViewExtension(
  "myoxus:page",
  EDGELESS_TOOLBAR_WIDGET,
  EDGELESS_TOOLBAR_WIDGET,
);
