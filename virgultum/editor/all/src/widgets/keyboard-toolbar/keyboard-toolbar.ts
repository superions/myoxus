import { computed, effect, type Signal, signal } from "@preact/signals-core";
import { getSelectedModelsCommand } from "@virgultum/core/commands";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { BlockComponent } from "@virgultum/core/runtime";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  type EditorKeyboardAction,
  type EditorKeyboardToolbarControls,
  resolveLegacyEditorText,
  type VirtualKeyboardProviderWithAction,
} from "@virgultum/core/services";

import type {
  KeyboardIconType,
  KeyboardToolbarConfig,
  KeyboardToolbarContext,
  KeyboardToolbarItem,
  KeyboardToolPanelConfig,
} from "./config";
import type { MyoxusKeyboardToolPanel } from "./keyboard-tool-panel.js";
import {
  isKeyboardSubToolBarConfig,
  isKeyboardToolBarActionItem,
  isKeyboardToolPanelConfig,
} from "./utils";

export const MYOXUS_KEYBOARD_TOOLBAR = "myoxus-keyboard-toolbar";

export class MyoxusKeyboardToolbar extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _expanded$ = signal(false);
  private readonly _currentPanelIndex$ = signal(-1);
  private readonly _lastActiveItem$ = signal<KeyboardToolbarItem | null>(null);
  private readonly _path$ = signal<number[]>([]);
  private readonly _revision$ = signal(0);

  private _keyboard!: VirtualKeyboardProviderWithAction;
  private _config!: KeyboardToolbarConfig;
  private _rootComponent!: BlockComponent;

  private _toolbarHost: HTMLDivElement | null = null;
  private _toolPanelEl: MyoxusKeyboardToolPanel | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedRoot: BlockComponent | null = null;

  get keyboard(): VirtualKeyboardProviderWithAction {
    return this._keyboard;
  }
  set keyboard(value: VirtualKeyboardProviderWithAction) {
    this._keyboard = value;
    this._bump();
  }

  get config(): KeyboardToolbarConfig {
    return this._config;
  }
  set config(value: KeyboardToolbarConfig) {
    this._config = value;
    this._bump();
  }

  get rootComponent(): BlockComponent {
    return this._rootComponent;
  }
  set rootComponent(value: BlockComponent) {
    const changed = this._rootComponent !== value;
    this._rootComponent = value;
    if (changed && this.isConnected) {
      this._bindRoot();
    }
    this._bump();
  }

  get std() {
    return this.rootComponent.std;
  }

  get panelOpened() {
    return this._currentPanelIndex$.value !== -1;
  }

  private get panelHeight() {
    return this._expanded$.value
      ? `${
          this.keyboard.staticHeight$.value !== 0
            ? this.keyboard.staticHeight$.value
            : 330
        }px`
      : this.keyboard.appTabSafeArea$.value;
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  /**
   * Prevent flickering during keyboard opening
   */
  private _resetPanelIndexTimeoutId: ReturnType<typeof setTimeout> | null =
    null;
  private readonly _closeToolPanel = () => {
    if (!this.keyboard.visible$.peek()) this.keyboard.show();

    if (this._resetPanelIndexTimeoutId) {
      clearTimeout(this._resetPanelIndexTimeoutId);
      this._resetPanelIndexTimeoutId = null;
    }
    this._resetPanelIndexTimeoutId = setTimeout(() => {
      this._currentPanelIndex$.value = -1;
    }, 100);
  };

  private readonly _goPrevToolbar = () => {
    if (!this._isSubToolbarOpened) return;

    if (this.panelOpened) this._closeToolPanel();

    this._path$.value = this._path$.value.slice(0, -1);
  };

  private readonly _handleItemClick = (
    item: KeyboardToolbarItem,
    index: number,
  ) => {
    if (isKeyboardToolBarActionItem(item)) {
      item.action &&
        Promise.resolve(item.action(this._context)).catch(console.error);
    } else if (isKeyboardSubToolBarConfig(item)) {
      this._closeToolPanel();
      this._path$.value = [...this._path$.value, index];
    } else if (isKeyboardToolPanelConfig(item)) {
      if (this._currentPanelIndex$.value === index) {
        this._closeToolPanel();
      } else {
        if (this._resetPanelIndexTimeoutId) {
          clearTimeout(this._resetPanelIndexTimeoutId);
          this._resetPanelIndexTimeoutId = null;
        }
        this._currentPanelIndex$.value = index;
        this.keyboard.hide();
        this._scrollCurrentBlockIntoView();
      }
    }
    this._lastActiveItem$.value = item;
  };

  private readonly _scrollCurrentBlockIntoView = () => {
    if (!this._rootComponent) return;
    this.std.command
      .chain()
      .pipe(getSelectedModelsCommand)
      .pipe(({ selectedModels }) => {
        if (!selectedModels?.length) return;

        const block = this.std.view.getBlock(selectedModels[0].id);
        if (!block) return;

        const { y: y1 } = this.getBoundingClientRect();
        const { bottom: y2 } = block.getBoundingClientRect();
        const gap = 8;

        if (y2 < y1 + gap) return;

        scrollTo({
          top: window.scrollY + y2 - y1 + gap,
          behavior: "instant",
        });
      })
      .run();
  };

  private get _context(): KeyboardToolbarContext {
    return {
      std: this.std,
      rootComponent: this.rootComponent,
      closeToolPanel: () => {
        this._closeToolPanel();
      },
    };
  }

  private get _currentPanelConfig(): KeyboardToolPanelConfig | null {
    if (!this.panelOpened) return null;

    const result = this._currentToolbarItems[this._currentPanelIndex$.value];

    return isKeyboardToolPanelConfig(result) ? result : null;
  }

  private get _currentToolbarItems(): KeyboardToolbarItem[] {
    let items = this.config.items;
    for (const index of this._path$.value) {
      if (isKeyboardSubToolBarConfig(items[index])) {
        items = items[index].items;
      } else {
        break;
      }
    }

    return items.filter((item) =>
      isKeyboardToolBarActionItem(item)
        ? (item.showWhen?.(this._context) ?? true)
        : true,
    );
  }

  private get _isSubToolbarOpened() {
    return this._path$.value.length > 0;
  }

  private _renderIcon(icon: KeyboardIconType) {
    return typeof icon === "function" ? icon(this._context) : icon;
  }

  private _presentItem(
    item: KeyboardToolbarItem,
    index: number,
  ): EditorKeyboardAction {
    const action = isKeyboardToolBarActionItem(item);
    const panel = isKeyboardToolPanelConfig(item);
    const active = action
      ? typeof item.active === "function"
        ? item.active(this._context)
        : item.active
      : panel && this._currentPanelIndex$.value === index;
    const icon =
      panel && active && item.activeIcon ? item.activeIcon : item.icon;
    const label = item.name ?? "More";
    const i18n = this.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    return {
      id: `${this._path$.value.join(".")}:${index}`,
      label: resolveLegacyEditorText(label, i18n) ?? label,
      icon: this._renderIcon(icon),
      active,
      disabled:
        ("disableWhen" in item && item.disableWhen?.(this._context)) ?? false,
      run: () => this._handleItemClick(item, index),
    };
  }

  private readonly _toggleKeyboard = () => {
    if (this.keyboard.staticHeight$.value === 0) {
      this._closeToolPanel();
    } else if (this.keyboard.visible$.peek()) {
      this.keyboard.hide();
    } else {
      this.keyboard.show();
    }
  };

  private readonly _controls$ = computed<EditorKeyboardToolbarControls | null>(
    () => {
      void this._revision$.value;
      if (!this._rootComponent || !this._config || !this._keyboard) return null;
      const active = this.std.event.active$.value;
      return {
        actions: active
          ? this._currentToolbarItems.map((item, index) =>
              this._presentItem(item, index),
            )
          : [],
        back:
          active && this._isSubToolbarOpened ? this._goPrevToolbar : undefined,
        keyboardVisible: this.keyboard.visible$.value,
        toggleKeyboard: this._toggleKeyboard,
      };
    },
  );

  private _bindRoot() {
    if (!this._rootComponent || !this._toolbarHost) return;
    if (this._mountedRoot !== this._rootComponent) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._mountedRoot = this._rootComponent;
      const chrome = this.std.getOptional(EditorChromeHostIdentifier);
      if (chrome) {
        this._chromeUnmount = chrome.mountKeyboardToolbar(
          this._toolbarHost,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    // The keyboard's inset/panel owns viewport geometry; native controls own all chrome.
    Object.assign(this.style, {
      position: "fixed",
      display: "block",
      width: "100vw",
      bottom: "0",
    });

    if (!this._toolbarHost) {
      this._toolbarHost = this.ownerDocument.createElement("div");
      this._toolbarHost.style.display = "contents";
    }
    if (!this._toolPanelEl) {
      this._toolPanelEl = this.ownerDocument.createElement(
        "myoxus-keyboard-tool-panel",
      ) as MyoxusKeyboardToolPanel;
    }
    if (this._toolbarHost.parentElement !== this) {
      this.replaceChildren(this._toolbarHost, this._toolPanelEl);
    }

    this._bindRoot();

    // There are two cases that `_expanded$` will be true:
    // 1. when virtual keyboard is opened, the panel need to be expanded and overlapped by the keyboard,
    // so that the toolbar will be on the top of the keyboard.
    // 2. the panel is opened, whether the keyboard is closed or not exists (e.g. a physical keyboard connected)
    //
    // There is one case that `_expanded$` will be false:
    // 1. the panel is closed, and the keyboard is closed, the toolbar will be rendered at the bottom of the viewport
    this.disposables.add(
      effect(() => {
        if (!this._keyboard) return;
        if (this._keyboard.visible$.value || this.panelOpened) {
          this._expanded$.value = true;
        } else {
          this._expanded$.value = false;
        }
      }),
    );

    // Sync child tool panel props & height
    this.disposables.add(
      effect(() => {
        void this._revision$.value;
        if (
          !this._toolPanelEl ||
          !this._rootComponent ||
          !this._config ||
          !this._keyboard
        ) {
          return;
        }
        this._toolPanelEl.config = this._currentPanelConfig;
        this._toolPanelEl.context = this._context;
        this._toolPanelEl.style.height = this.panelHeight;
        this._toolPanelEl.style.paddingBottom =
          this._keyboard.appTabSafeArea$.value;
      }),
    );

    // prevent editor blur when click item in toolbar
    this.disposables.addFromEvent(this, "pointerdown", (e) => {
      e.preventDefault();
    });

    this.disposables.add(
      effect(() => {
        if (!this._rootComponent) return;
        const std = this._rootComponent.std;
        void std.selection.value;
        // wait cursor updated
        requestAnimationFrame(() => {
          this._scrollCurrentBlockIntoView();
        });
      }),
    );

    this.disposables.add(
      effect(() => {
        if (!this._keyboard) return;
        // sometime the keyboard will auto show when user click into different paragraph in Android,
        // so we need to close the tool panel explicitly when the keyboard is visible
        if (this._keyboard.visible$.value) {
          this._closeToolPanel();
        }
      }),
    );

    if (this._config && this._rootComponent) {
      this._watchAutoShow();
    }

    // workaround for the virtual keyboard showing transition animation
    const timeoutId = setTimeout(() => {
      this._scrollCurrentBlockIntoView();
    }, 700);
    this.disposables.add(() => {
      clearTimeout(timeoutId);
    });

    this.disposables.add(() => {
      if (this._resetPanelIndexTimeoutId) {
        clearTimeout(this._resetPanelIndexTimeoutId);
        this._resetPanelIndexTimeoutId = null;
      }
    });
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedRoot = null;
    this.disposables.dispose();
  }

  private _watchAutoShow() {
    const autoShowSubToolbars: { path: number[]; signal: Signal<boolean> }[] =
      [];

    const traverse = (item: KeyboardToolbarItem, path: number[]) => {
      if (isKeyboardSubToolBarConfig(item) && item.autoShow) {
        autoShowSubToolbars.push({
          path,
          signal: item.autoShow(this._context),
        });

        item.items.forEach((subItem, index) => {
          traverse(subItem, [...path, index]);
        });
      }
    };
    this.config.items.forEach((item, index) => {
      traverse(item, [index]);
    });

    const samePath = (a: number[], b: number[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);

    let prevPath = this._path$.peek();
    this.disposables.add(
      effect(() => {
        autoShowSubToolbars.forEach(({ path, signal }) => {
          if (signal.value) {
            if (samePath(this._path$.peek(), path)) return;

            prevPath = this._path$.peek();
            this._path$.value = path;
          } else {
            this._path$.value = prevPath;
          }
        });
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_KEYBOARD_TOOLBAR]: MyoxusKeyboardToolbar;
  }
}
