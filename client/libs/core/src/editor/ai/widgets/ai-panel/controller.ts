// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import { popoverViewportMiddlewares } from "@myoxus/ui-facade";
import { computed, signal } from "@preact/signals-core";
import { type Container, createIdentifier } from "@virgultum/editor/global/di";
import { DisposableGroup } from "@virgultum/editor/global/disposable";
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
import {
  type BlockStdScope,
  type EditorHost,
  LifeCycleWatcher,
} from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/editor/std/inline";
import type { BaseSelection } from "@virgultum/editor/store";
import {
  MYOXUS_VIEWPORT_OVERLAY_WIDGET,
  type MyoxusViewportOverlayWidget,
} from "@virgultum/editor/widgets/viewport-overlay";
import { createElement, type ReactNode } from "react";

import { mantineLengthPx } from "../../_common/mantine-length";
import { chatI18n } from "../../components/chat-i18n";
import type { AIError } from "../../provider";
import { NativeAIWidgetUI } from "../native-ui";
import type {
  AIActionAnswer,
  MyoxusAIPanelState,
  MyoxusAIPanelWidgetConfig,
} from "./type";
import { mergeAIActionAnswer } from "./utils";
import { AIPanelView } from "./view";

export const AIPanelControllerIdentifier = createIdentifier<AIPanelController>(
  "MyoxusAIPanelController",
);

/**
 * Signal-driven controller for the Edgeless inline AI panel.
 *
 * Mounts its plain overlay element inside `myoxus-edgeless-root > .widgets-container`
 * so `EdgelessCopilotWidget` action-menu anchoring and image-export exclusion continue to work
 * without registering a custom element or imperative render scheduler.
 */
export class AIPanelController extends LifeCycleWatcher {
  static override key = "myoxus-ai-panel-controller";

  static override setup(di: Container) {
    super.setup(di);
    di.addImpl(AIPanelControllerIdentifier, (provider) =>
      provider.get(AIPanelController),
    );
  }

  readonly element: HTMLDivElement;
  readonly disposables = new DisposableGroup();

  readonly state$ = signal<MyoxusAIPanelState>("hidden");
  readonly config$ = signal<MyoxusAIPanelWidgetConfig | null>(null);
  readonly answer$ = signal<AIActionAnswer | null>(null);
  readonly error$ = signal<AIError | undefined>(undefined);
  readonly inputText$ = signal<string | null>(null);
  readonly loadingProgress$ = signal<number>(1);
  readonly answerContextVersion$ = signal<number>(0);

  inputElement: HTMLTextAreaElement | null = null;
  ctx: unknown = null;

  private _abortController = new AbortController();
  private _discardModalAbort: AbortController | null = null;
  private _selection?: BaseSelection[];
  private _stopAutoUpdate?: () => void;
  private _disposeOpenHostPointerDown?: () => void;
  private _pendingLoadingProgress = 1;
  private _disposed = false;

  private readonly _setInputElement = (element: HTMLTextAreaElement | null) => {
    this.inputElement = element;
  };

  readonly view = computed<ReactNode>(() => {
    const state = this.state$.value;
    const config = this.config$.value;
    const rawAnswer = this.answer$.value;
    const progress = this.loadingProgress$.value;
    const answerContextVersion = this.answerContextVersion$.value;
    // Read error$ so error updates trigger re-render even when state stays "error".
    void this.error$.value;

    if (state === "hidden" || !config) return null;

    return createElement(AIPanelView, {
      state,
      config,
      host: this.host,
      answer: rawAnswer ? mergeAIActionAnswer(rawAnswer) : null,
      progress,
      answerContextVersion,
      onInput: this.onInput,
      onFinish: this._inputFinish,
      onStop: this.stopGenerating,
      setInput: this._setInputElement,
    });
  });

  readonly generatingElement = {
    updateLoadingProgress: (progress: number) => {
      this.updateLoadingProgress(progress);
    },
  };

  constructor(std: BlockStdScope) {
    super(std);
    const element = document.createElement("div");
    element.dataset.myoxusAiPanel = "";
    element.dataset.state = "hidden";
    element.hidden = true;
    element.tabIndex = -1;
    // Floating-UI owns document/canvas anchoring; Mantine chrome owns visible styling.
    element.style.position = "absolute";
    element.style.zIndex = "var(--myoxus-z-index-popover)";
    // Exclude inline AI textarea edits from Virgultum selection range synchronization.
    element.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    this.element = element;
  }

  get host(): EditorHost {
    return this.std.host;
  }

  get config(): MyoxusAIPanelWidgetConfig | null {
    return this.config$.peek();
  }

  set config(value: MyoxusAIPanelWidgetConfig | null) {
    this.config$.value = value;
  }

  get state(): MyoxusAIPanelState {
    return this.state$.peek();
  }

  set state(next: MyoxusAIPanelState) {
    const prev = this.state$.peek();
    if (next === prev) {
      this._syncSurfaceChrome(next);
      return;
    }

    this.state$.value = next;

    // Synchronously capture or restore editor selection on visibility/phase transitions
    // so callers such as hideCallback never race a deferred render microtask.
    if (prev === "hidden") {
      this._selection = this.host.selection.value;
    } else {
      this.restoreSelection();
    }

    this.std
      .get(ToolbarRegistryIdentifier)
      .flags.toggle(ToolbarFlag.Hiding, next !== "hidden" && next !== "input");

    this._syncSurfaceChrome(next);
  }

  get answer(): string | null {
    const raw = this.answer$.peek();
    return raw ? mergeAIActionAnswer(raw) : null;
  }

  get inputText(): string | null {
    return this.inputText$.peek();
  }

  get viewportOverlayWidget(): MyoxusViewportOverlayWidget | null {
    const rootId = this.host.store.root?.id;
    return rootId
      ? (this.host.view.getWidget(
          MYOXUS_VIEWPORT_OVERLAY_WIDGET,
          rootId,
        ) as MyoxusViewportOverlayWidget)
      : null;
  }

  /**
   * Notify reactive views that external action context (such as async slide
   * compilation in AIContext) changed and action availability must be re-evaluated.
   */
  notifyAnswerContextChanged = () => {
    if (this._disposed) return;
    this.answerContextVersion$.value = this.answerContextVersion$.peek() + 1;
  };

  /**
   * Defer progress signal writes by one microtask because answer renderers may
   * advance loading stages while `AIPanelView` is rendering.
   */
  updateLoadingProgress = (progress: number) => {
    if (progress === this._pendingLoadingProgress) return;
    this._pendingLoadingProgress = progress;
    queueMicrotask(() => {
      if (this._disposed) return;
      if (this.loadingProgress$.peek() !== this._pendingLoadingProgress) {
        this.loadingProgress$.value = this._pendingLoadingProgress;
      }
    });
  };

  override mounted() {
    super.mounted();
    this._disposed = false;
    this._attachToWidgetsContainer();

    const mount = this.std.getOptional(NativeAIWidgetUI);
    if (mount) {
      this.disposables.add(mount(this.element, this.view));
    }

    this.disposables.add(
      this.std.view.viewUpdated.subscribe((payload) => {
        if (payload.type === "block" && payload.method === "add") {
          this._attachToWidgetsContainer();
        }
      }),
    );

    this.disposables.addFromEvent(
      document,
      "pointerdown",
      this._onDocumentClick,
    );
    this.disposables.add(
      this.host.event.add("click", () => this.state !== "hidden"),
    );

    this.disposables.addFromEvent(this.element, "wheel", stopPropagation);
    this.disposables.addFromEvent(this.element, "pointerdown", stopPropagation);
    this.disposables.addFromEvent(this.element, "pointerup", stopPropagation);
    this.disposables.addFromEvent(this.element, "cut", stopPropagation);
    this.disposables.addFromEvent(this.element, "copy", stopPropagation);
    this.disposables.addFromEvent(this.element, "paste", stopPropagation);
    this.disposables.addFromEvent(this.element, "keydown", this._onKeyDown);
  }

  override unmounted() {
    this._disposed = true;
    this._abortController.abort();
    this._clearDiscardModal();
    this._stopAutoUpdate?.();
    this._stopAutoUpdate = undefined;
    this._disposeOpenHostPointerDown?.();
    this._disposeOpenHostPointerDown = undefined;
    if (this.state !== "hidden") {
      this.viewportOverlayWidget?.unlock();
      this.std
        .get(ToolbarRegistryIdentifier)
        .flags.toggle(ToolbarFlag.Hiding, false);
    }
    this.disposables.dispose();
    this.element.remove();
    super.unmounted();
  }

  onInput = (text: string) => {
    this.inputText$.value = text;
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
    this._attachToWidgetsContainer();
    this.state = state;
    this._autoUpdatePosition(reference);
  };

  toggle = (reference: Element, type: "input" | "generate") => {
    this._attachToWidgetsContainer();
    if (type === "generate") {
      this.inputText$.value = "";
      this.generate();
    } else if (type === "input") {
      this.hide();
      this.state = "input";
    }
    this._autoUpdatePosition(reference);
  };

  generate = () => {
    this._attachToWidgetsContainer();
    this._pendingLoadingProgress = 1;
    this.loadingProgress$.value = 1;
    this.restoreSelection();

    const text = this.inputText$.peek();
    const config = this.config;
    if (!config) {
      throw new Error("config is not found");
    }
    if (text === null || text === undefined) {
      throw new Error("text is not found");
    }
    if (!config.generateAnswer) {
      throw new Error("generateAnswer is not found");
    }

    this._resetAbortController();
    this.answer$.value = null;

    const request = this._abortController;
    const isCurrent = () =>
      request === this._abortController && !request.signal.aborted;

    const update = (answer: AIActionAnswer) => {
      if (!isCurrent()) return;
      this.answer$.value = answer;
    };

    const finish = (type: "success" | "error" | "aborted", err?: AIError) => {
      if (type === "aborted" || !isCurrent()) return;

      const activeConfig = this.config;
      if (!activeConfig) {
        throw new Error("config is not found when finish");
      }
      if (type === "error") {
        activeConfig.errorStateConfig.error = err;
        this.error$.value = err;
        this.state = "error";
      } else {
        activeConfig.errorStateConfig.error = undefined;
        this.error$.value = undefined;
        this.state = "finished";
      }

      this._resetAbortController();
    };

    this.element.scrollTop = 0;
    this.state = "generating";
    config.generateAnswer({
      input: text,
      update,
      finish,
      signal: request.signal,
    });
  };

  hide = (shouldTriggerCallback = true) => {
    this._resetAbortController();
    this._stopAutoUpdate?.();
    this._stopAutoUpdate = undefined;
    this.inputText$.value = null;
    this.answer$.value = null;
    this.state = "hidden";
    this.viewportOverlayWidget?.unlock();
    if (shouldTriggerCallback) {
      this.config?.hideCallback?.();
    }
  };

  discard = () => {
    this.hide();
    this.restoreSelection();
    this.config?.discardCallback?.();
  };

  stopGenerating = () => {
    this._abortController.abort();
    this.state = "finished";
    if (!this.answer) {
      this.hide();
    }
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
        if (this._discardModalAbort === controller) {
          this._discardModalAbort = null;
        }
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
        if (this._discardModalAbort === controller) {
          this._discardModalAbort = null;
        }
      });
  };

  private _syncSurfaceChrome(state: MyoxusAIPanelState) {
    if (state === "hidden") {
      this._disposeOpenHostPointerDown?.();
      this._disposeOpenHostPointerDown = undefined;
      this.viewportOverlayWidget?.unlock();
    } else {
      // Register host pointerDown after viewport-overlay-widget has mounted so
      // LIFO dispatch lets outside-click dismissal run before the lock overlay consumes it.
      if (!this._disposeOpenHostPointerDown && !this._disposed) {
        this._disposeOpenHostPointerDown = this.host.event.add(
          "pointerDown",
          (evtState) => {
            this._onDocumentClick(evtState.get("pointerState").raw);
          },
        );
      }
      this.viewportOverlayWidget?.lock();
    }
    this.element.dataset.state = state;
    this.element.hidden = state === "hidden";
  }

  private _attachToWidgetsContainer() {
    if (this._disposed) return;
    const widgetsContainer = this.host.querySelector(
      "myoxus-edgeless-root > .widgets-container",
    );
    if (
      widgetsContainer instanceof HTMLElement &&
      this.element.parentElement !== widgetsContainer
    ) {
      widgetsContainer.append(this.element);
    }
  }

  private readonly _clearDiscardModal = () => {
    if (this._discardModalAbort) {
      this._discardModalAbort.abort();
      this._discardModalAbort = null;
    }
  };

  private readonly _resetAbortController = () => {
    if (this.state === "generating") {
      this._abortController.abort();
    }
    this._abortController = new AbortController();
  };

  private readonly _inputFinish = (text: string) => {
    this.inputText$.value = text;
    this.generate();
  };

  private readonly _clickOutside = () => {
    if (this.state === "generating") {
      this._stopWithConfirmation();
    } else {
      this._discardWithConfirmation();
    }
  };

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
        if (discard) this.discard();
      })
      .catch(console.error);
  };

  private readonly _onDocumentClick = (event: MouseEvent) => {
    if (
      this.state !== "hidden" &&
      !this._discardModalAbort &&
      event.target !== this.element &&
      !this.element.contains(event.target as Node)
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
    if (event.key === "Escape") {
      if (state === "generating") {
        this.stopGenerating();
      } else {
        this.hide();
      }
    }
  };

  private _autoUpdatePosition(reference: Element) {
    // Anchor to the heading/text sibling when a block wrapper encloses nested children.
    const childrenContainer = reference.querySelector(
      ".myoxus-block-children-container",
    );
    if (childrenContainer && childrenContainer.previousElementSibling) {
      reference = childrenContainer.previousElementSibling;
    }

    this._stopAutoUpdate?.();
    this._stopAutoUpdate = autoUpdate(reference, this.element, () => {
      computePosition(
        reference,
        this.element,
        this._calcPositionOptions(reference),
      )
        .then(({ x, y }) => {
          this.element.style.left = `${x}px`;
          this.element.style.top = `${y}px`;
        })
        .catch(console.error);
    });
  }

  private _calcPositionOptions(
    reference: Element,
  ): Partial<ComputePositionConfig> {
    let rootBoundary: Rect | undefined;
    const panelOffset = mantineLengthPx(this.element, "--mantine-spacing-sm");
    const overflowPadding = mantineLengthPx(
      this.element,
      "--mantine-spacing-lg",
      "--mantine-spacing-xs",
    );
    const edgelessElementOffset = mantineLengthPx(
      this.element,
      "--mantine-spacing-lg",
    );
    const edgelessToolbarReserve =
      mantineLengthPx(
        this.element,
        "--mantine-spacing-2xl",
        "--mantine-spacing-sm",
      ) *
        2 +
      overflowPadding;

    const docModeProvider = this.host.std.get(DocModeProvider);
    if (docModeProvider.getEditorMode() !== "page") {
      const viewport = this.host.std.get(GfxControllerIdentifier).viewport;
      rootBoundary = {
        x: viewport.left,
        y: viewport.top,
        width: viewport.width,
        height: viewport.height - edgelessToolbarReserve,
      };
    }

    const overflowOptions = {
      padding: overflowPadding,
      rootBoundary,
    };

    const constrain = size({
      ...popoverViewportMiddlewares.size,
      ...overflowOptions,
    });

    if (getPageRootByElement(reference)) {
      return {
        placement: "bottom-start",
        middleware: [offset(panelOffset), shift(overflowOptions), constrain],
      };
    }

    if (reference.closest("edgeless-block-portal-note")) {
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
