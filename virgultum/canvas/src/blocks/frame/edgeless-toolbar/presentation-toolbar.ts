import { effect } from "@preact/signals-core";
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/canvas-runtime/surface";
import { PanTool } from "@virgultum/canvas-runtime/tools";
import { Bound, clamp } from "@virgultum/core/primitives/gfx";
import type { FrameBlockModel } from "@virgultum/core/models";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  type EditorPresentationToolbarControls,
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
import {
  generateKeyBetweenV2,
  type ToolOptionWithType,
  type ToolOptions,
} from "@virgultum/core/runtime/gfx";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import {
  EdgelessFrameManagerIdentifier,
  isFrameBlock,
  type NavigatorMode,
} from "../frame-manager";
import { PresentTool } from "../present-tool";

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
  private _blackBackground = false;
  private _frameMenuShow = false;
  private _settingMenuShow = false;
  private _setFrameMenuShow: (show: boolean) => void = () => {};
  private _setSettingMenuShow: (show: boolean) => void = () => {};

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

  get host() {
    return this.edgeless.host;
  }

  get slots() {
    return this.edgeless.std.get(EdgelessLegacySlotIdentifier);
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
    if (this.edgeless.store.readonly) {
      this.setEdgelessTool(PanTool, { panning: false });
    } else {
      this.setEdgelessTool(DefaultTool);
    }

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.error);
    }

    this.edgeless.std
      .get(EditPropsStore)
      .setStorage("presentNoFrameToastShown", false);
  }

  private _moveToCurrentFrame(forceMove = false) {
    const currentToolOption = this.gfx.tool.currentToolOption$.peek();
    const toolOptions = currentToolOption?.options;

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

  private readonly _onBlackBackgroundChange = (checked: boolean) => {
    this._blackBackground = checked;
    this.slots.navigatorSettingUpdated.next({ blackBackground: checked });
    this.edgeless.std
      .get(EditPropsStore)
      .setStorage("presentBlackBackground", checked);
    this.requestUpdate();
  };

  private readonly _moveFrame = (id: string, before: string | null) => {
    if (this.edgeless.store.readonly || id === before) return;
    const manager = this.edgeless.std.get(EdgelessFrameManagerIdentifier);
    const frames = manager.frames;
    const source = frames.findIndex((frame) => frame.id === id);
    const target =
      before === null
        ? frames.length
        : frames.findIndex((frame) => frame.id === before);
    if (source < 0 || target < 0 || target === source || target === source + 1)
      return;

    manager.refreshLegacyFrameOrder();
    const neighbours = manager.frames.filter((frame) => frame.id !== id);
    const insertion =
      before === null
        ? neighbours.length
        : neighbours.findIndex((frame) => frame.id === before);
    this.edgeless.std.get(EdgelessCRUDIdentifier).updateElement(id, {
      presentationIndex: generateKeyBetweenV2(
        neighbours[insertion - 1]?.props.presentationIndex || null,
        neighbours[insertion]?.props.presentationIndex || null,
      ),
    });
    this.edgeless.store.captureSync();
    this.requestUpdate();
  };

  protected override onConnected(): void {
    const { _disposables } = this;
    this._blackBackground =
      this.edgeless.std
        .get(EditPropsStore)
        .getStorage("presentBlackBackground") ?? false;

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
                editorMessage(
                  "com.myoxus.editor.presentation.no-frame-toast",
                  "The presentation requires at least 1 frame. Create a frame first.",
                ),
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
      this.slots.navigatorSettingUpdated.subscribe(
        ({ fillScreen, blackBackground }) => {
          if (fillScreen !== undefined) {
            this._navigatorMode = fillScreen ? "fill" : "fit";
          }
          if (blackBackground !== undefined) {
            this._blackBackground = blackBackground;
          }
          this.requestUpdate();
        },
      ),
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
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const current = this._currentFrameIndex;
    const frames = this._frames;
    const frame = frames[current];
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    const readonly = this.edgeless.store.readonly;

    if (chrome?.mountPresentationToolbar) {
      const frameOrderLabel = this._text(
        editorMessage(
          "com.myoxus.editor.presentation.frame-order",
          "Frame order",
        ),
      );
      const settingsLabel = this._text(
        editorMessage("com.myoxus.sidebar.outline.settings", "Settings"),
      );
      const controls: EditorPresentationToolbarControls = {
        previous: {
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
        },
        next: {
          action: {
            id: "presentation-next",
            icon: "EndPointArrowIcon",
            label: this._text(
              editorMessage("com.myoxus.editor.presentation.next", "Next"),
            ),
            disabled: false,
            run: () => this._nextFrame(),
          },
        },
        title:
          frame?.props.title.toString() ||
          this._text(
            editorMessage(
              "com.myoxus.editor.presentation.no-frame",
              "No frame",
            ),
          ),
        count: `${frames.length === 0 ? 0 : current + 1} / ${frames.length}`,
        focusCurrentFrame: () => this._moveToCurrentFrame(true),
        fullscreen: {
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
        frameOrder: {
          opened: this.frameMenuShow && !readonly,
          onClose: () => this.setFrameMenuShow(false),
          position: "top",
          offset: 16,
          label: frameOrderLabel,
          trigger: {
            action: {
              id: "presentation-frame-order",
              icon: "LayerIcon",
              label: frameOrderLabel,
              disabled: readonly,
              run: () => {
                if (readonly) return;
                this.setFrameMenuShow(!this.frameMenuShow);
              },
            },
            expanded: this.frameMenuShow,
          },
          content: {
            kind: "frame-order",
            controls: {
              items: frames.map((item) => ({
                id: item.id,
                title: item.props.title.toString(),
              })),
              embedded: false,
              readonly,
              move: this._moveFrame,
            },
          },
        },
        settings: {
          opened: this.settingMenuShow,
          onClose: () => this.setSettingMenuShow(false),
          position: "top",
          offset: 16,
          label: settingsLabel,
          trigger: {
            action: {
              id: "presentation-settings",
              icon: "SettingsIcon",
              label: settingsLabel,
              disabled: false,
              run: () => this.setSettingMenuShow(!this.settingMenuShow),
            },
            expanded: this.settingMenuShow,
          },
          content: {
            kind: "menu",
            controls: {
              actions: [
                {
                  id: "presentation-settings-label",
                  label: this._text(
                    editorMessage(
                      "com.myoxus.sidebar.frame.playback-settings",
                      "Playback Settings",
                    ),
                  ),
                  disabled: false,
                },
                {
                  id: "presentation-dark-background",
                  label: this._text(
                    editorMessage(
                      "com.myoxus.sidebar.frame.dark-background",
                      "Black background",
                    ),
                  ),
                  disabled: false,
                  control: {
                    type: "toggle",
                    checked: this._blackBackground,
                    change: this._onBlackBackgroundChange,
                  },
                },
                {
                  id: "presentation-hide-toolbar",
                  label: this._text(
                    editorMessage(
                      "com.myoxus.sidebar.frame.hide-toolbar",
                      "Hide toolbar",
                    ),
                  ),
                  disabled: false,
                  control: {
                    type: "toggle",
                    checked: this._cachedPresentHideToolbar,
                    change: (checked: boolean) => {
                      this._cachedPresentHideToolbar = checked;
                    },
                  },
                },
              ],
            },
          },
        },
        stop: {
          action: {
            id: "presentation-stop",
            icon: "StopAiIcon",
            label: this._text(
              editorMessage("com.myoxus.peek-view-controls.close", "Close"),
            ),
            disabled: false,
            run: () => this._exitPresentation(),
          },
        },
      };

      this.mountSlot(
        "presentation",
        this,
        chrome.mountPresentationToolbar,
        controls,
      );
    }

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
    element.mozRequestFullScreen();
  } else if (
    "webkitRequestFullscreen" in element &&
    element.webkitRequestFullscreen instanceof Function
  ) {
    element.webkitRequestFullscreen();
  } else if (
    "msRequestFullscreen" in element &&
    element.msRequestFullscreen instanceof Function
  ) {
    element.msRequestFullscreen();
  }
}
