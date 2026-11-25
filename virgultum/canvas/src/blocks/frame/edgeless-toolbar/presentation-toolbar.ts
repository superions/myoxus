import { cssVar } from "@myoxus/theme";
import { effect } from "@preact/signals-core";
import {
  DefaultTool,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/canvas-runtime/surface";
import { PanTool } from "@virgultum/canvas-runtime/tools";
import { Bound, clamp } from "@virgultum/core/primitives/gfx";
import type { FrameBlockModel } from "@virgultum/core/models";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  ViewportElementProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { editorToast } from "@virgultum/core/utils";
import {
  type BlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import type {
  ToolOptionWithType,
  ToolOptions,
} from "@virgultum/core/runtime/gfx";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import {
  EdgelessFrameManagerIdentifier,
  isFrameBlock,
  type NavigatorMode,
} from "../frame-manager";
import { PresentTool } from "../present-tool";
import type { EdgelessFrameOrderButton } from "../present/frame-order-button";
import type { EdgelessNavigatorSettingButton } from "../present/navigator-setting-button";

const presentationToolbarStyles = `
  presentation-toolbar {
    /* Preserve the tool mixin's host layout at the light-DOM boundary. */
    display: flex;
    align-items: inherit;
    width: 100%;
    height: 100%;
    gap: 8px;
    padding-right: 2px;

    .full-divider {
      width: 8px;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .full-divider::after {
      content: "";
      width: 1px;
      height: 100%;
      background: var(--myoxus-border-color);
      transform: scaleX(0.5);
    }
    .config-buttons {
      display: flex;
      gap: 10px;
    }
    .edgeless-frame-navigator {
      width: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .edgeless-frame-navigator.dense {
      width: auto;
    }

    .edgeless-frame-navigator-title {
      display: inline-block;
      cursor: pointer;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      padding-right: 8px;
    }

    .edgeless-frame-navigator-count {
      color: var(--myoxus-text-secondary-color);
      white-space: nowrap;
    }
  }
`;

export class PresentationToolbar extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  private _cachedIndex = -1;
  private _timer?: ReturnType<typeof setTimeout>;
  private _currentFrameIndex = 0;
  private _frameIndexVersion = 0;
  private _appliedFrameIndexVersion = -1;
  private _appliedToolOption: ToolOptionWithType | null = null;
  private _fullScreenMode = true;
  private _navigatorMode: NavigatorMode = "fit";
  private _containerWidth = 1920;
  private _frameMenuShow = false;
  private _settingMenuShow = false;
  private _setFrameMenuShow: (show: boolean) => void = () => {};
  private _setSettingMenuShow: (show: boolean) => void = () => {};

  private _domReady = false;
  private _prevSlot!: HTMLSpanElement;
  private _navigatorEl!: HTMLDivElement;
  private _titleEl!: HTMLSpanElement;
  private _countEl!: HTMLSpanElement;
  private _nextSlot!: HTMLSpanElement;
  private _configButtons!: HTMLDivElement;
  private _fullscreenSlot!: HTMLSpanElement;
  private _frameOrderBtn: EdgelessFrameOrderButton | null = null;
  private _settingBtn!: EdgelessNavigatorSettingButton;
  private _stopSlot!: HTMLSpanElement;

  override type = PresentTool;

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  private get _cachedPresentHideToolbar() {
    return !!this.edgeless.std
      .get(EditPropsStore)
      .getStorage("presentHideToolbar");
  }

  private set _cachedPresentHideToolbar(value) {
    this.edgeless.std
      .get(EditPropsStore)
      .setStorage("presentHideToolbar", !!value);
    this.requestUpdate();
  }

  private get _frames(): FrameBlockModel[] {
    return this.edgeless.std.get(EdgelessFrameManagerIdentifier).frames;
  }

  get dense() {
    return this._containerWidth < 554;
  }

  get host() {
    return this.edgeless.host;
  }

  get slots() {
    return this.edgeless.std.get(EdgelessLegacySlotIdentifier);
  }

  get containerWidth() {
    return this._containerWidth;
  }

  set containerWidth(value: number) {
    if (this._containerWidth === value) return;
    this._containerWidth = value;
    this.requestUpdate();
  }

  get frameMenuShow() {
    return this._frameMenuShow;
  }

  set frameMenuShow(value: boolean) {
    if (this._frameMenuShow === value) return;
    this._frameMenuShow = value;
    this.requestUpdate();
  }

  get settingMenuShow() {
    return this._settingMenuShow;
  }

  set settingMenuShow(value: boolean) {
    if (this._settingMenuShow === value) return;
    this._settingMenuShow = value;
    this.requestUpdate();
  }

  get setFrameMenuShow() {
    return this._setFrameMenuShow;
  }

  set setFrameMenuShow(value: (show: boolean) => void) {
    this._setFrameMenuShow = value;
    this.requestUpdate();
  }

  get setSettingMenuShow() {
    return this._setSettingMenuShow;
  }

  set setSettingMenuShow(value: (show: boolean) => void) {
    this._setSettingMenuShow = value;
    this.requestUpdate();
  }

  constructor(edgeless?: BlockComponent) {
    super();
    if (edgeless) this.edgeless = edgeless;
  }

  private _setCurrentFrameIndex(index: number) {
    this._currentFrameIndex = index;
    this._frameIndexVersion += 1;
    this.requestUpdate();
  }

  private _bindHotKey() {
    const handleKeyIfFrameNavigator = (action: () => void) => () => {
      if (this.edgelessTool?.toolType === PresentTool) {
        action();
      }
    };

    this._disposables.add(
      this.edgeless.bindHotKey(
        {
          ArrowLeft: handleKeyIfFrameNavigator(() => this._previousFrame()),
          ArrowRight: handleKeyIfFrameNavigator(() => this._nextFrame()),
          Escape: handleKeyIfFrameNavigator(() => this._exitPresentation()),
        },
        {
          global: true,
        },
      ),
    );
  }

  private _exitPresentation() {
    // When exit presentation mode, we need to set the tool to default or pan
    // And exit fullscreen
    if (this.edgeless.store.readonly) {
      this.setEdgelessTool(PanTool, { panning: false });
    } else {
      this.setEdgelessTool(DefaultTool);
    }

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.error);
    }

    // Reset the flag when fully exiting presentation mode
    this.edgeless.std
      .get(EditPropsStore)
      .setStorage("presentNoFrameToastShown", false);
  }

  private _moveToCurrentFrame(forceMove = false) {
    const currentToolOption = this.gfx.tool.currentToolOption$.peek();
    const toolOptions = currentToolOption?.options;

    // If PresentTool is being activated after a temporary pan (indicated by restoredAfterPan)
    // and a forced move isn't explicitly requested, skip moving to the current frame.
    // This preserves the user's panned position instead of resetting to the frame's default view.
    if (
      currentToolOption?.toolType === PresentTool &&
      toolOptions?.restoredAfterPan &&
      !forceMove
    ) {
      const currentTool = this.gfx.tool.currentTool$.peek();
      if (currentTool?.activatedOption) {
        currentTool.activatedOption.restoredAfterPan = false;
      }
      return;
    }

    const current = this._currentFrameIndex;
    const viewport = this.gfx.viewport;
    const frame = this._frames[current];

    if (frame) {
      let bound = Bound.deserialize(frame.xywh);

      if (this._navigatorMode === "fill") {
        const vb = viewport.viewportBounds;
        const center = bound.center;
        let w, h;
        if (vb.w / vb.h > bound.w / bound.h) {
          w = bound.w;
          h = (w * vb.h) / vb.w;
        } else {
          h = bound.h;
          w = (h * vb.w) / vb.h;
        }
        bound = Bound.fromCenter(center, w, h);
      }

      viewport.setViewportByBound(bound, [0, 0, 0, 0], false);
      this.slots.navigatorFrameChanged.next(
        this._frames[this._currentFrameIndex],
      );
    }
  }

  private _nextFrame() {
    const frames = this._frames;
    const min = 0;
    const max = frames.length - 1;
    if (this._currentFrameIndex === frames.length - 1) {
      editorToast(
        this.host,
        editorMessage(
          "com.myoxus.editor.presentation.last-frame",
          "You have reached the last frame",
        ),
      );
    } else {
      this._setCurrentFrameIndex(clamp(this._currentFrameIndex + 1, min, max));
    }
  }

  private _previousFrame() {
    const frames = this._frames;
    const min = 0;
    const max = frames.length - 1;
    if (this._currentFrameIndex === 0) {
      editorToast(
        this.host,
        editorMessage(
          "com.myoxus.editor.presentation.first-frame",
          "You have reached the first frame",
        ),
      );
    } else {
      this._setCurrentFrameIndex(clamp(this._currentFrameIndex - 1, min, max));
    }
  }

  /**
   * Toggle fullscreen, but keep edgeless tool to frameNavigator
   * If already fullscreen, exit fullscreen
   * If not fullscreen, enter fullscreen
   */
  private _toggleFullScreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.error);
      this._fullScreenMode = false;
    } else {
      const { viewportElement } = this.edgeless.std.get(
        ViewportElementProvider,
      );
      launchIntoFullscreen(viewportElement);
      this._fullScreenMode = true;
    }
  }

  private _ensureDom() {
    if (this._domReady) return;
    this._domReady = true;
    const style = this.ownerDocument.createElement("style");
    style.textContent = presentationToolbarStyles;

    this._prevSlot = this.ownerDocument.createElement("span");
    this._prevSlot.style.display = "contents";

    this._navigatorEl = this.ownerDocument.createElement("div");
    this._navigatorEl.className = "edgeless-frame-navigator";

    this._titleEl = this.ownerDocument.createElement("span");
    this._titleEl.className = "edgeless-frame-navigator-title";
    this._titleEl.style.color = cssVar("textPrimaryColor");
    this._titleEl.addEventListener("click", () => this._moveToCurrentFrame());

    this._countEl = this.ownerDocument.createElement("span");
    this._countEl.className = "edgeless-frame-navigator-count";

    this._navigatorEl.append(this._titleEl, this._countEl);

    this._nextSlot = this.ownerDocument.createElement("span");
    this._nextSlot.style.display = "contents";

    const divider1 = this.ownerDocument.createElement("div");
    divider1.className = "full-divider";

    this._configButtons = this.ownerDocument.createElement("div");
    this._configButtons.className = "config-buttons";

    this._fullscreenSlot = this.ownerDocument.createElement("span");
    this._fullscreenSlot.style.display = "contents";

    this._settingBtn = this.ownerDocument.createElement(
      "edgeless-navigator-setting-button",
    );

    this._configButtons.append(this._fullscreenSlot, this._settingBtn);

    const divider2 = this.ownerDocument.createElement("div");
    divider2.className = "full-divider";

    this._stopSlot = this.ownerDocument.createElement("span");
    this._stopSlot.style.display = "contents";

    this.append(
      style,
      this._prevSlot,
      this._navigatorEl,
      this._nextSlot,
      divider1,
      this._configButtons,
      divider2,
      this._stopSlot,
    );
  }

  protected override onConnected(): void {
    this._ensureDom();
    const { _disposables } = this;

    _disposables.add(
      effect(() => {
        const currentToolOption = this.gfx.tool.currentToolOption$.value;

        if (currentToolOption?.toolType === PresentTool) {
          const opts = currentToolOption.options as
            ToolOptions<PresentTool> | undefined;

          const isAlreadyFullscreen = !!document.fullscreenElement;

          if (!isAlreadyFullscreen) {
            this._toggleFullScreen();
          } else {
            this._fullScreenMode = true;
          }

          this._cachedIndex = this._currentFrameIndex;
          this._navigatorMode = opts?.mode ?? this._navigatorMode;

          const selection = this.gfx.selection;
          if (
            selection.selectedElements.length > 0 &&
            isFrameBlock(selection.selectedElements[0])
          ) {
            const selectedFrameId = selection.selectedElements[0].id;
            const indexOfSelectedFrame = this._frames.findIndex(
              (frame) => frame.id === selectedFrameId,
            );
            if (indexOfSelectedFrame !== -1) {
              this._cachedIndex = indexOfSelectedFrame;
            }
          }

          const store = this.edgeless.std.get(EditPropsStore);
          if (this._frames.length === 0) {
            if (!store.getStorage("presentNoFrameToastShown")) {
              editorToast(
                this.host,
                "The presentation requires at least 1 frame. You can firstly create a frame.",
                5000,
              );
              store.setStorage("presentNoFrameToastShown", true);
            }
          } else {
            if (store.getStorage("presentNoFrameToastShown")) {
              store.setStorage("presentNoFrameToastShown", false);
            }
          }
        }
        this.requestUpdate();
      }),
    );

    this._bindHotKey();

    _disposables.add(
      this.slots.navigatorSettingUpdated.subscribe(({ fillScreen }) => {
        if (fillScreen !== undefined) {
          this._navigatorMode = fillScreen ? "fill" : "fit";
          this.requestUpdate();
        }
      }),
    );

    _disposables.addFromEvent(document, "fullscreenchange", () => {
      if (document.fullscreenElement) {
        this._timer = setTimeout(() => {
          this._setCurrentFrameIndex(this._cachedIndex);
        }, 400);
      } else {
        clearTimeout(this._timer);
        if (
          this.edgelessTool?.toolType === PresentTool &&
          this._fullScreenMode
        ) {
          if (this.edgeless.store.readonly) {
            this.setEdgelessTool(PanTool, { panning: false });
          } else {
            this.setEdgelessTool(DefaultTool);
          }
        }
      }

      setTimeout(() => this._moveToCurrentFrame(true), 400);
      this.slots.fullScreenToggled.next();
      this.requestUpdate();
    });

    this._navigatorMode =
      this.edgeless.std.get(EditPropsStore).getStorage("presentFillScreen") ===
      true
        ? "fill"
        : "fit";
  }

  override disconnectedCallback() {
    clearTimeout(this._timer);
    this._appliedFrameIndexVersion = -1;
    this._appliedToolOption = null;
    super.disconnectedCallback();
  }

  protected override paint() {
    this._ensureDom();
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const current = this._currentFrameIndex;
    const frames = this._frames;
    const frame = frames[current];
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);

    if (chrome) {
      this.mountSlot("prev", this._prevSlot, chrome.mountCanvasTool, {
        action: {
          id: "presentation-previous",
          icon: "StartPointArrowIcon",
          label: this._text(
            editorMessage(
              "com.myoxus.editor.presentation.previous",
              "Previous",
            ),
          ),
          disabled: false,
          run: () => this._previousFrame(),
        },
      });
      this.mountSlot("next", this._nextSlot, chrome.mountCanvasTool, {
        action: {
          id: "presentation-next",
          icon: "EndPointArrowIcon",
          label: this._text(
            editorMessage("com.myoxus.editor.presentation.next", "Next"),
          ),
          disabled: false,
          run: () => this._nextFrame(),
        },
      });
      this.mountSlot(
        "fullscreen",
        this._fullscreenSlot,
        chrome.mountCanvasTool,
        {
          action: {
            id: "presentation-fullscreen",
            icon: document.fullscreenElement
              ? "ExpandCloseIcon"
              : "ExpandFullIcon",
            label: this._text(
              editorMessage(
                "com.myoxus.workbench.split-view-menu.full-screen",
                "Full screen",
              ),
            ),
            active: !!document.fullscreenElement,
            disabled: false,
            run: () => this._toggleFullScreen(),
          },
        },
      );
      this.mountSlot("stop", this._stopSlot, chrome.mountCanvasTool, {
        action: {
          id: "presentation-stop",
          icon: "StopAiIcon",
          label: this._text(
            editorMessage("com.myoxus.peek-view-controls.close", "Close"),
          ),
          disabled: false,
          run: () => this._exitPresentation(),
        },
      });
    }

    this._navigatorEl.classList.toggle("dense", this.dense);
    this._titleEl.style.display = this.dense ? "none" : "";
    this._titleEl.textContent = frame?.props.title.toString() ?? "no frame";
    this._countEl.textContent = `${frames.length === 0 ? 0 : current + 1} / ${frames.length}`;

    if (this.dense) {
      if (this._frameOrderBtn) {
        this._frameOrderBtn.remove();
        this._frameOrderBtn = null;
      }
    } else {
      if (!this._frameOrderBtn) {
        this._frameOrderBtn = this.ownerDocument.createElement(
          "edgeless-frame-order-button",
        );
        this._configButtons.insertBefore(this._frameOrderBtn, this._settingBtn);
      }
      this._frameOrderBtn.popperShow = this.frameMenuShow;
      this._frameOrderBtn.setPopperShow = this.setFrameMenuShow;
      this._frameOrderBtn.edgeless = this.edgeless;
    }

    this._settingBtn.edgeless = this.edgeless;
    this._settingBtn.hideToolbar = this._cachedPresentHideToolbar;
    this._settingBtn.onHideToolbarChange = (hideToolbar: boolean) => {
      this._cachedPresentHideToolbar = hideToolbar;
    };
    this._settingBtn.popperShow = this.settingMenuShow;
    this._settingBtn.setPopperShow = this.setSettingMenuShow;
    this._settingBtn.includeFrameOrder = this.dense;

    // Mirror Lit's updated() side effect: move viewport when frame index or PresentTool activates.
    const currentToolOption = this.gfx.tool.currentToolOption$.peek();
    const isPresentToolActive = currentToolOption?.toolType === PresentTool;
    const isRestoredAfterPan = !!(
      isPresentToolActive && currentToolOption?.options?.restoredAfterPan
    );

    const frameIndexChanged =
      this._appliedFrameIndexVersion !== this._frameIndexVersion;
    const toolChanged = this._appliedToolOption !== this.edgelessTool;
    this._appliedFrameIndexVersion = this._frameIndexVersion;
    this._appliedToolOption = this.edgelessTool;

    if (frameIndexChanged && isPresentToolActive) {
      this._moveToCurrentFrame(!isRestoredAfterPan);
    } else if (
      isPresentToolActive &&
      toolChanged &&
      this.edgelessTool?.toolType === PresentTool
    ) {
      this._moveToCurrentFrame(!isRestoredAfterPan);
    }
  }
}

function launchIntoFullscreen(element: Element) {
  if (element.requestFullscreen) {
    element.requestFullscreen().catch(console.error);
  } else if (
    "mozRequestFullScreen" in element &&
    element.mozRequestFullScreen instanceof Function
  ) {
    // Firefox
    element.mozRequestFullScreen();
  } else if (
    "webkitRequestFullscreen" in element &&
    element.webkitRequestFullscreen instanceof Function
  ) {
    // Chrome, Safari and Opera
    element.webkitRequestFullscreen();
  } else if (
    "msRequestFullscreen" in element &&
    element.msRequestFullscreen instanceof Function
  ) {
    // IE/Edge
    element.msRequestFullscreen();
  }
}
