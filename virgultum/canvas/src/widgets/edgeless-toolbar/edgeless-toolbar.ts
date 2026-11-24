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
import debounce from "lodash-es/debounce";

import type { MenuPopper } from "./create-popper.js";
import {
  QuickToolIdentifier,
  SeniorToolIdentifier,
} from "./extension/index.js";

const TOOLBAR_PADDING_X = 12;
const QUICK_TOOLS_GAP = 10;
const QUICK_TOOL_SIZE = 36;
const QUICK_TOOL_MORE_SIZE = 20;
const SENIOR_TOOLS_GAP = 0;
const SENIOR_TOOL_WIDTH = 96;
const SENIOR_TOOL_NAV_SIZE = 20;
const DIVIDER_WIDTH = 8;
const DIVIDER_SPACE = 8;
const SAFE_AREA_WIDTH = 64;

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
  .edgeless-toolbar-toggle-control[data-enable="true"]:hover {
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

  private containerWidth = 1920;

  private readonly _onContainerResize = debounce(
    ({ w }: { w: number }) => {
      if (!this.isConnected) return;

      this.containerWidth = w;
      this.requestUpdate();

      if (this._denseSeniorTools) {
        this.scrollSeniorToolIndex = Math.min(
          this._seniorTools.length - this.scrollSeniorToolSize,
          this.scrollSeniorToolIndex,
        );
      } else {
        this.scrollSeniorToolIndex = 0;
      }
    },
    300,
    { leading: true },
  );

  private _resizeObserver: ResizeObserver | null = null;

  activePopper: MenuPopper<HTMLElement> | null = null;

  // calculate all the width manually
  private get _availableWidth() {
    return this.containerWidth - 2 * SAFE_AREA_WIDTH;
  }

  private get _cachedPresentHideToolbar() {
    return !!this.std.get(EditPropsStore).getStorage("presentHideToolbar");
  }

  private get _denseQuickTools() {
    return (
      this._availableWidth -
        this._seniorToolNavWidth -
        1 * SENIOR_TOOL_WIDTH -
        2 * TOOLBAR_PADDING_X <
      this._quickToolsWidthTotal
    );
  }

  private get _denseSeniorTools() {
    return (
      this._availableWidth -
        this._quickToolsWidthTotal -
        this._spaceWidthTotal <
      this._seniorToolsWidthTotal
    );
  }

  /**
   * When enabled, the toolbar will auto-hide when the mouse is not over it.
   */
  private get _enableAutoHide() {
    return (
      this.isPresentMode &&
      this._cachedPresentHideToolbar &&
      !this.presentSettingMenuShow &&
      !this.presentFrameMenuShow
    );
  }

  private get _hiddenQuickTools() {
    return this._quickTools
      .slice(this._visibleQuickToolSize)
      .filter((tool) => !!tool.menu);
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

  private get _quickToolsWidthTotal() {
    return (
      this._quickTools.length * (QUICK_TOOL_SIZE + QUICK_TOOLS_GAP) -
      QUICK_TOOLS_GAP
    );
  }

  private get _seniorNextTooltip() {
    if (this._seniorScrollNextDisabled) return "";
    const nextTool =
      this._seniorTools[this.scrollSeniorToolIndex + this.scrollSeniorToolSize];
    return typeof nextTool?.name === "string"
      ? nextTool.name
      : nextTool?.name
        ? this._text(nextTool.name)
        : "";
  }

  private get _seniorPrevTooltip() {
    if (this._seniorScrollPrevDisabled) return "";
    const prevTool = this._seniorTools[this.scrollSeniorToolIndex - 1];
    return typeof prevTool?.name === "string"
      ? prevTool.name
      : prevTool?.name
        ? this._text(prevTool.name)
        : "";
  }

  private get _seniorScrollNextDisabled() {
    return (
      this.scrollSeniorToolIndex + this.scrollSeniorToolSize >=
      this._seniorTools.length
    );
  }

  private get _seniorScrollPrevDisabled() {
    return this.scrollSeniorToolIndex === 0;
  }

  private get _seniorToolNavWidth() {
    return this._denseSeniorTools
      ? (SENIOR_TOOL_NAV_SIZE + DIVIDER_SPACE) * 2
      : 0;
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

  private get _seniorToolsWidthTotal() {
    return (
      this._seniorTools.length * (SENIOR_TOOL_WIDTH + SENIOR_TOOLS_GAP) -
      SENIOR_TOOLS_GAP
    );
  }

  private get _spaceWidthTotal() {
    return DIVIDER_WIDTH + DIVIDER_SPACE * 2 + TOOLBAR_PADDING_X * 2;
  }

  private get _visibleQuickToolSize() {
    if (!this._denseQuickTools) return this._quickTools.length;
    const availableWidth =
      this._availableWidth -
      this._seniorToolNavWidth -
      this._spaceWidthTotal -
      SENIOR_TOOL_WIDTH;
    return Math.max(
      1,
      Math.floor(
        (availableWidth - QUICK_TOOL_MORE_SIZE - DIVIDER_SPACE) /
          (QUICK_TOOL_SIZE + QUICK_TOOLS_GAP),
      ),
    );
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

  get scrollSeniorToolSize() {
    if (this._denseQuickTools) return 1;
    const seniorAvailableWidth =
      this._availableWidth - this._quickToolsWidthTotal - this._spaceWidthTotal;
    if (seniorAvailableWidth >= this._seniorToolsWidthTotal)
      return this._seniorTools.length;
    return (
      Math.floor(
        (seniorAvailableWidth - (SENIOR_TOOL_NAV_SIZE + DIVIDER_SPACE) * 2) /
          SENIOR_TOOL_WIDTH,
      ) || 1
    );
  }

  private _onSeniorNavNext() {
    if (this._seniorScrollNextDisabled) return;
    this.scrollSeniorToolIndex = Math.min(
      this._seniorTools.length - this.scrollSeniorToolSize,
      this.scrollSeniorToolIndex + this.scrollSeniorToolSize,
    );
    this.requestUpdate();
  }

  private _onSeniorNavPrev() {
    if (this._seniorScrollPrevDisabled) return;
    this.scrollSeniorToolIndex = Math.max(
      0,
      this.scrollSeniorToolIndex - this.scrollSeniorToolSize,
    );
    this.requestUpdate();
  }

  private toolbarControls(): EditorCanvasToolbarControls {
    return {
      setContainer: this.setContainer,
      quick: this._quickTools
        .slice(0, this._visibleQuickToolSize)
        .map((tool) => tool.content),
      senior: this._seniorTools
        .slice(
          this.scrollSeniorToolIndex,
          this.scrollSeniorToolIndex + this.scrollSeniorToolSize,
        )
        .map((tool) => tool.content),
      more:
        this._denseQuickTools && this._hiddenQuickTools.length
          ? {
              id: "canvas-more-tools",
              icon: "MoreHorizontalIcon",
              label: this._text(
                editorMessage(
                  "com.myoxus.editor.toolbar.more-tools",
                  "More tools",
                ),
              ),
              disabled: false,
              control: {
                type: "menu",
                items: this._hiddenQuickTools.map((tool) => tool.menu!),
              },
            }
          : undefined,
      navigation: this._denseSeniorTools
        ? [
            {
              id: "canvas-tools-previous",
              icon: "ArrowLeftSmallIcon",
              label: this._seniorPrevTooltip || "Previous",
              disabled: this._seniorScrollPrevDisabled,
              run: () => this._onSeniorNavPrev(),
            },
            {
              id: "canvas-tools-next",
              icon: "ArrowRightSmallIcon",
              label: this._seniorNextTooltip || "Next",
              disabled: this._seniorScrollNextDisabled,
              run: () => this._onSeniorNavNext(),
            },
          ]
        : [],
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
              containerWidth: this.containerWidth,
            }
          : undefined,
    };
  }

  override connectedCallback() {
    super.connectedCallback();
    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        this._onContainerResize({ w: width });
      }
    });
    this._resizeObserver.observe(this);
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
      this.gfx.tool.currentToolName$.subscribe(() => this.requestUpdate()),
    );
    this.disposables.add(
      this.std.store.readonly$.subscribe(() => this.requestUpdate()),
    );
    this.disposables.add(() => this._onContainerResize.cancel());
    this.observeToolbar();
    if (!this.block) return;
    this.disposables.add(
      this.block.bindHotKey(
        {
          Escape: () => {
            if (this.gfx.selection.editing) return;
            if (this.edgelessTool === "frameNavigator") return;
            if (this.edgelessTool === "default") {
              if (this.activePopper) {
                this.activePopper.dispose();
                this.activePopper = null;
              }
              return;
            }
            this.gfx.tool.setTool(DefaultTool);
          },
        },
        { global: true },
      ),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.controls.value = null;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
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
    // This state from `editPropsStore` is not reactive,
    // if the value is updated outside of this component, it will not be reflected.
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

  private scrollSeniorToolIndex = 0;

  toolbarContainer!: HTMLElement;
}

export const edgelessToolbarWidget = WidgetViewExtension(
  "myoxus:page",
  EDGELESS_TOOLBAR_WIDGET,
  EDGELESS_TOOLBAR_WIDGET,
);
