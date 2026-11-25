import { popoverViewportMiddlewares } from "@myoxus/ui-facade";
import { signal } from "@preact/signals-core";
import { createElement, type ReactNode } from "react";
import { NativeAIWidgetUI } from "../native-ui";
import { AIPanelView } from "./view";
import {
  autoPlacement,
  autoUpdate,
  computePosition,
  type ComputePositionConfig,
  flip,
  offset,
  type Rect,
  shift,
  size,
} from "@floating-ui/dom";
import {
  DocModeProvider,
  NotificationProvider,
  ToolbarFlag,
  ToolbarRegistryIdentifier,
} from "@virgultum/editor/shared/services";
import {
  getPageRootByElement,
  stopPropagation,
} from "@virgultum/editor/shared/utils";
import { NativeEditorWidget, WidgetViewExtension } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/editor/std/inline";
import type { BaseSelection } from "@virgultum/editor/store";
import {
  MYOXUS_VIEWPORT_OVERLAY_WIDGET,
  type MyoxusViewportOverlayWidget,
} from "@virgultum/editor/widgets/viewport-overlay";

import { mantineLengthPx } from "../../_common/mantine-length";
import { chatI18n } from "../../components/chat-i18n";
import { type AIError } from "../../provider";
import type {
  MyoxusAIPanelState,
  AIActionAnswer,
  MyoxusAIPanelWidgetConfig,
} from "./type.js";
import { mergeAIActionAnswer } from "./utils";
export const MYOXUS_AI_PANEL_WIDGET = "myoxus-ai-panel-widget";

export class MyoxusAIPanelWidget extends NativeEditorWidget {
  private readonly view = signal<ReactNode>(null);
  private mounted = false;
  private pendingRender = false;
  private completion = Promise.resolve(true);
  private finishRender?: (connected: boolean) => void;
  private previousState: MyoxusAIPanelState = "hidden";

  get updateComplete() {
    return this.completion;
  }

  private readonly commitView = () => {
    if (this.pendingRender) return;
    this.finishRender?.(this.isConnected);
    this.finishRender = undefined;
  };

  requestUpdate() {
    if (!this.mounted || this.pendingRender) return;
    this.pendingRender = true;
    if (!this.finishRender)
      this.completion = new Promise((resolve) => (this.finishRender = resolve));
    const lifetime = this.disposables;
    queueMicrotask(() => {
      if (this.disposables !== lifetime || !this.mounted) return;
      this.pendingRender = false;
      this.updateState();
      const view = this.renderPanel();
      if (Object.is(view, this.view.peek())) this.commitView();
      else this.view.value = view;
    });
  }
  inputElement: HTMLTextAreaElement | null = null;
  private loadingProgress = 1;
  readonly generatingElement = {
    updateLoadingProgress: (progress: number) => {
      if (progress === this.loadingProgress) return;
      this.loadingProgress = progress;
      this.requestUpdate();
    },
  };

  private _abortController = new AbortController();

  private _answer: AIActionAnswer | null = null;

  private readonly _clearDiscardModal = () => {
    if (this._discardModalAbort) {
      this._discardModalAbort.abort();
      this._discardModalAbort = null;
    }
  };

  private readonly _clickOutside = () => {
    if (this.state === "generating") {
      this._stopWithConfirmation();
    } else {
      this._discardWithConfirmation();
    }
  };

  private _discardModalAbort: AbortController | null = null;

  private readonly _inputFinish = (text: string) => {
    this._inputText = text;
    this.generate();
  };

  private _inputText: string | null = null;

  private readonly _onDocumentClick = (e: MouseEvent) => {
    if (
      this.state !== "hidden" &&
      e.target !== this &&
      !this.contains(e.target as Node)
    ) {
      this._clickOutside();
    }
  };

  private readonly _onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    const { state } = this;
    if (state !== "generating" && state !== "input") {
      return;
    }

    const { key } = event;
    if (key === "Escape") {
      if (state === "generating") {
        this.stopGenerating();
      } else {
        this.hide();
      }
      return;
    }
  };

  private readonly _resetAbortController = () => {
    if (this.state === "generating") {
      this._abortController.abort();
    }
    this._abortController = new AbortController();
  };

  private _selection?: BaseSelection[];

  private _stopAutoUpdate?: undefined | (() => void);

  ctx: unknown = null;

  private readonly _stopWithConfirmation = () => {
    this.showStopModal()
      .then((stop) => {
        if (stop) {
          this.stopGenerating();
        }
      })
      .catch(console.error);
  };

  private readonly _discardWithConfirmation = () => {
    if (this.state === "hidden") {
      return;
    }
    if (this.state === "input" || !this.answer) {
      this.hide();
      return;
    }
    this.showDiscardModal()
      .then((discard) => {
        discard && this.discard();
      })
      .catch(console.error);
  };

  discard = () => {
    this.hide();
    this.restoreSelection();
    this.config?.discardCallback?.();
  };

  /**
   * You can evaluate this method multiple times to regenerate the answer.
   */
  generate = () => {
    this.loadingProgress = 1;
    this.restoreSelection();

    const text = this._inputText;
    if (!this.config) {
      throw new Error("config is not found");
    }
    if (text === null || text === undefined) {
      throw new Error("text is not found");
    }
    if (!this.config.generateAnswer) {
      throw new Error("generateAnswer is not found");
    }

    this._resetAbortController();

    // reset answer
    this._answer = null;

    const request = this._abortController;
    const isCurrent = () =>
      request === this._abortController && !request.signal.aborted;
    const update = (answer: AIActionAnswer) => {
      if (!isCurrent()) return;
      this._answer = answer;
      this.requestUpdate();
    };
    const finish = (type: "success" | "error" | "aborted", err?: AIError) => {
      if (type === "aborted" || !isCurrent()) return;

      if (!this.config) {
        throw new Error("config is not found when finish");
      }
      if (type === "error") {
        this.state = "error";
        this.config.errorStateConfig.error = err;
      } else {
        this.state = "finished";
        this.config.errorStateConfig.error = undefined;
      }

      this._resetAbortController();
    };

    this.scrollTop = 0; // reset scroll top
    this.state = "generating";
    this.config.generateAnswer({
      input: text,
      update,
      finish,
      signal: request.signal,
    });
  };

  hide = (shouldTriggerCallback: boolean = true) => {
    this._resetAbortController();
    this.state = "hidden";
    this._stopAutoUpdate?.();
    this._inputText = null;
    this._answer = null;
    this._stopAutoUpdate = undefined;
    this.viewportOverlayWidget?.unlock();
    if (shouldTriggerCallback) {
      this.config?.hideCallback?.();
    }
  };

  onInput = (text: string) => {
    this._inputText = text;
    this.config?.inputCallback?.(text);
  };

  restoreSelection = () => {
    if (this._selection) {
      this.host.selection.set([...this._selection]);
      if (this.state === "hidden") {
        this._selection = undefined;
      }
    }
  };

  setState = (state: MyoxusAIPanelState, reference: Element) => {
    this.state = state;
    this._autoUpdatePosition(reference);
  };

  showStopModal = () => {
    const notification = this.host.std.getOptional(NotificationProvider);
    if (!notification) {
      return Promise.resolve(true);
    }
    this._clearDiscardModal();
    const controller = new AbortController();
    this._discardModalAbort = controller;
    const t = chatI18n();
    return notification
      .confirm({
        title: t["com.myoxus.ai.chat-panel.stop"](),
        message: t["com.myoxus.ai.chat-panel.stop-confirm-message"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.ai.chat-panel.stop-confirm-action"](),
        abort: controller.signal,
      })
      .finally(() => {
        if (this._discardModalAbort === controller)
          this._discardModalAbort = null;
      });
  };

  showDiscardModal = () => {
    const notification = this.host.std.getOptional(NotificationProvider);
    if (!notification) {
      return Promise.resolve(true);
    }
    this._clearDiscardModal();
    const controller = new AbortController();
    this._discardModalAbort = controller;
    const t = chatI18n();
    return notification
      .confirm({
        title: t["com.myoxus.ai.chat-panel.discard-result-title"](),
        message: t["com.myoxus.ai.chat-panel.discard-result-message"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.ai.chat-panel.discard-result-action"](),
        abort: controller.signal,
      })
      .finally(() => {
        if (this._discardModalAbort === controller)
          this._discardModalAbort = null;
      });
  };

  stopGenerating = () => {
    this._abortController.abort();
    this.state = "finished";
    if (!this.answer) {
      this.hide();
    }
  };

  toggle = (reference: Element, type: "input" | "generate") => {
    if (type === "generate") {
      this._inputText = "";
      this.generate();
    } else if (type === "input") {
      this.hide();
      this.state = "input";
    }
    this._autoUpdatePosition(reference);
  };

  get answer() {
    return this._answer ? mergeAIActionAnswer(this._answer) : null;
  }

  get inputText() {
    return this._inputText;
  }

  get viewportOverlayWidget() {
    const rootId = this.host.store.root?.id;
    return rootId
      ? (this.host.view.getWidget(
          MYOXUS_VIEWPORT_OVERLAY_WIDGET,
          rootId,
        ) as MyoxusViewportOverlayWidget)
      : null;
  }

  private _autoUpdatePosition(reference: Element) {
    // workaround for the case that the reference contains children block elements, like:
    // paragraph
    //    child paragraph
    {
      const childrenContainer = reference.querySelector(
        ".myoxus-block-children-container",
      );
      if (childrenContainer && childrenContainer.previousElementSibling) {
        reference = childrenContainer.previousElementSibling;
      }
    }

    this._stopAutoUpdate?.();
    this._stopAutoUpdate = autoUpdate(reference, this, () => {
      computePosition(reference, this, this._calcPositionOptions(reference))
        .then(({ x, y }) => {
          this.style.left = `${x}px`;
          this.style.top = `${y}px`;
        })
        .catch(console.error);
    });
  }

  private _calcPositionOptions(
    reference: Element,
  ): Partial<ComputePositionConfig> {
    let rootBoundary: Rect | undefined;
    const panelOffset = mantineLengthPx(this, "--mantine-spacing-sm");
    const overflowPadding = mantineLengthPx(
      this,
      "--mantine-spacing-lg",
      "--mantine-spacing-xs",
    );
    const edgelessElementOffset = mantineLengthPx(this, "--mantine-spacing-lg");
    const edgelessToolbarReserve =
      mantineLengthPx(this, "--mantine-spacing-2xl", "--mantine-spacing-sm") *
        2 +
      overflowPadding;
    {
      const docModeProvider = this.host.std.get(DocModeProvider);
      if (docModeProvider.getEditorMode() === "page") {
        rootBoundary = undefined;
      } else {
        const gfx = this.host.std.get(GfxControllerIdentifier);
        // TODO circular dependency: instanceof EdgelessRootService
        const viewport = gfx.viewport;
        rootBoundary = {
          x: viewport.left,
          y: viewport.top,
          width: viewport.width,
          // Floating UI needs the edgeless toolbar reserve in pixels; source it
          // from Mantine spacing instead of freezing product chrome geometry.
          height: viewport.height - edgelessToolbarReserve,
        };
      }
    }

    const overflowOptions = {
      padding: overflowPadding,
      rootBoundary: rootBoundary,
    };

    // The shared size contract defers ResizeObserver writes and retains the
    // owning editor's document/canvas boundary for native scrolling.
    const constrain = size({
      ...popoverViewportMiddlewares.size,
      ...overflowOptions,
    });

    // block element in page editor
    if (getPageRootByElement(reference)) {
      return {
        placement: "bottom-start",
        middleware: [offset(panelOffset), shift(overflowOptions), constrain],
      };
    }
    // block element in doc in edgeless editor
    else if (reference.closest("edgeless-block-portal-note")) {
      return {
        middleware: [
          offset(panelOffset),
          shift(overflowOptions),
          autoPlacement({
            ...overflowOptions,
            allowedPlacements: ["top-start", "bottom-start"],
          }),
          constrain,
        ],
      };
    }
    // edgeless element
    else {
      return {
        placement: "right-start",
        middleware: [
          offset({ mainAxis: edgelessElementOffset }),
          flip({
            mainAxis: true,
            crossAxis: true,
            flipAlignment: true,
            ...overflowOptions,
          }),
          shift({
            crossAxis: true,
            ...overflowOptions,
          }),
          constrain,
        ],
      };
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    const mount = this.std.getOptional(NativeAIWidgetUI);
    this.mounted = Boolean(mount);
    if (mount) this.disposables.add(mount(this, this.view, this.commitView));
    this.requestUpdate();

    this.tabIndex = -1;
    // Floating-UI owns document/canvas anchoring; native chrome owns all visible styling.
    this.style.position = "absolute";
    this.style.zIndex = "var(--myoxus-z-index-popover)";
    // No need to synchronize the contents of the input into the editor.
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    this.disposables.addFromEvent(
      document,
      "pointerdown",
      this._onDocumentClick,
    );
    if (this.block) {
      this.disposables.add(
        this.block.host.event.add("pointerDown", (evtState) =>
          this._onDocumentClick(
            evtState.get("pointerState").event as PointerEvent,
          ),
        ),
      );
      this.disposables.add(
        this.block.host.event.add("click", () => {
          return this.state !== "hidden" ? true : false;
        }),
      );
    }
    this.disposables.addFromEvent(this, "wheel", stopPropagation);
    this.disposables.addFromEvent(this, "pointerdown", stopPropagation);
    this.disposables.addFromEvent(this, "pointerup", stopPropagation);
    this.disposables.addFromEvent(this, "cut", stopPropagation);
    this.disposables.addFromEvent(this, "copy", stopPropagation);
    this.disposables.addFromEvent(this, "paste", stopPropagation);
    this.disposables.addFromEvent(this, "keydown", this._onKeyDown);
  }

  override disconnectedCallback() {
    this.mounted = false;
    this.pendingRender = false;
    this.commitView();
    this._abortController.abort();
    this._clearDiscardModal();
    this._stopAutoUpdate?.();
    if (this.state !== "hidden") {
      this.viewportOverlayWidget?.unlock();
      this.std
        .get(ToolbarRegistryIdentifier)
        .flags.toggle(ToolbarFlag.Hiding, false);
    }
    super.disconnectedCallback();
    this.view.value = null;
  }

  private renderPanel() {
    if (this.state === "hidden" || !this.config) return null;
    return createElement(AIPanelView, {
      state: this.state,
      config: this.config,
      host: this.host,
      answer: this.answer,
      progress: this.loadingProgress,
      onInput: this.onInput,
      onFinish: this._inputFinish,
      onStop: this.stopGenerating,
      setInput: (element: HTMLTextAreaElement | null) => {
        this.inputElement = element;
      },
    });
  }

  private updateState() {
    if (this.previousState !== this.state) {
      if (this.previousState === "hidden") {
        this._selection = this.host.selection.value;
      } else {
        this.restoreSelection();
      }
      this.previousState = this.state;
      this.std
        .get(ToolbarRegistryIdentifier)
        .flags.toggle(
          ToolbarFlag.Hiding,
          this.state !== "hidden" && this.state !== "input",
        );
    }

    if (this.state === "hidden") {
      this.viewportOverlayWidget?.unlock();
    } else {
      this.viewportOverlayWidget?.lock();
    }

    this.dataset.state = this.state;
    this.hidden = this.state === "hidden";
  }

  private _config: MyoxusAIPanelWidgetConfig | null = null;
  get config() {
    return this._config;
  }
  set config(value: MyoxusAIPanelWidgetConfig | null) {
    this._config = value;
    this.requestUpdate();
  }

  private _state: MyoxusAIPanelState = "hidden";
  get state() {
    return this._state;
  }
  set state(value: MyoxusAIPanelState) {
    if (value === this._state) return;
    this._state = value;
    this.requestUpdate();
  }
}

export const aiPanelWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_AI_PANEL_WIDGET,
  MYOXUS_AI_PANEL_WIDGET,
);
