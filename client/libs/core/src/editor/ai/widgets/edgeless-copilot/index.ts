import { popoverViewportMiddlewares } from "@myoxus/ui-facade";
import {
  autoPlacement,
  autoUpdate,
  computePosition,
  limitShift,
  offset,
  shift,
  size,
} from "@floating-ui/dom";
import { CopilotTool } from "@myoxus/core/editor/ai/tool/copilot-tool";
import { effect } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/editor/blocks/surface";
import {
  Bound,
  getCommonBoundWithRotation,
} from "@virgultum/editor/global/gfx";
import type { RootBlockModel } from "@virgultum/editor/model";
import {
  MOUSE_BUTTON,
  requestConnectedFrame,
} from "@virgultum/editor/shared/utils";
import { NativeEditorWidget, WidgetViewExtension } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";

import type { AIItemGroupConfig } from "../../components/ai-item/types.js";
import { AIProvider } from "../../provider/index.js";
import { extractSelectedContent } from "../../utils/extract.js";
import {
  MYOXUS_AI_PANEL_WIDGET,
  MyoxusAIPanelWidget,
} from "../ai-panel/ai-panel.js";
import { EdgelessCopilotPanel } from "../edgeless-copilot-panel/index.js";
import { MYOXUS_EDGELESS_COPILOT_WIDGET } from "./constant.js";

export class EdgelessCopilotWidget extends NativeEditorWidget<RootBlockModel> {
  readonly selectionElem = document.createElement("div");

  private _clickOutsideOff: (() => void) | null = null;

  private _copilotPanel!: EdgelessCopilotPanel | null;

  private _listenClickOutsideId: number | null = null;

  private _selectionModelRect!: DOMRect;

  private _autoUpdateCleanup: (() => void) | null = null;

  groups: AIItemGroupConfig[] = [];

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get selectionModelRect() {
    return this._selectionModelRect;
  }

  get selectionRect() {
    return this._selectionRect;
  }

  get visible() {
    return !!(
      this._visible &&
      this._selectionRect.width &&
      this._selectionRect.height
    );
  }

  set visible(visible: boolean) {
    this._visible = visible;
    this.renderSelection();
  }

  private _showCopilotInput() {
    requestConnectedFrame(() => {
      const referenceElement = this.selectionElem;
      if (!referenceElement || !referenceElement.isConnected) return;

      // show ai input
      const rootBlockId = this.host.store.root?.id;
      if (!rootBlockId) return;

      const input = this.host.view.getWidget(
        MYOXUS_AI_PANEL_WIDGET,
        rootBlockId,
      );

      if (input instanceof MyoxusAIPanelWidget) {
        input.setState("input", referenceElement);
        const aiPanel = input;
        // TODO: @xiaojun refactor these scattered config overrides
        if (aiPanel.config && !aiPanel.config.generateAnswer) {
          aiPanel.config.generateAnswer = ({ finish, input }) => {
            finish("success");
            aiPanel.hide();
            extractSelectedContent(this.host)
              .then((context) => {
                AIProvider.slots.requestSendWithChat.next({
                  input,
                  context,
                  host: this.host,
                });
              })
              .catch(console.error);
          };
          aiPanel.config.inputCallback = (text) => {
            const panel = this.querySelector("edgeless-copilot-panel");
            if (panel instanceof HTMLElement) {
              panel.style.visibility = text ? "hidden" : "visible";
            }
          };
        }
        requestAnimationFrame(() => {
          this._createCopilotPanel();
          this._updateCopilotPanel(input);
        });
      }
    }, this);
  }

  private _createCopilotPanel() {
    if (!this._copilotPanel) {
      const panel = new EdgelessCopilotPanel();
      panel.host = this.host;
      panel.groups = this.groups;
      this.append(panel);
      this._copilotPanel = panel;
    }
  }

  private _updateCopilotPanel(referenceElement: HTMLElement) {
    const panel = this._copilotPanel;
    if (!panel) return;

    const padding = { top: 10, right: 10, bottom: 150, left: 10 };

    this._autoUpdateCleanup?.();
    this._autoUpdateCleanup = autoUpdate(referenceElement, panel, () => {
      computePosition(referenceElement, panel, {
        placement: "bottom-start",
        middleware: [
          offset(4),
          autoPlacement({
            padding: 10,
            allowedPlacements: [
              "top-start",
              "top-end",
              "bottom-start",
              "bottom-end",
            ],
          }),
          size({ ...popoverViewportMiddlewares.size, padding }),
          shift({
            padding,
            limiter: limitShift(),
          }),
        ],
      })
        .then(({ x, y }) => {
          panel.style.left = `${x}px`;
          panel.style.top = `${y}px`;
        })
        .catch((e) => {
          console.warn("Can't compute EdgelessCopilotPanel position", e);
        });
    });
  }

  private _updateSelection(rect: DOMRect) {
    this._selectionModelRect = rect;

    const zoom = this.gfx.viewport.zoom;
    const [x, y] = this.gfx.viewport.toViewCoord(rect.left, rect.top);
    const [width, height] = [rect.width * zoom, rect.height * zoom];

    this._selectionRect = { x, y, width, height };
    this.renderSelection();
  }

  private _watchClickOutside() {
    this._clickOutsideOff?.();

    const { width, height } = this._selectionRect;

    if (width && height) {
      this._listenClickOutsideId &&
        cancelAnimationFrame(this._listenClickOutsideId);
      this._listenClickOutsideId = requestConnectedFrame(() => {
        if (!this.isConnected) {
          return;
        }

        const off = this.std.event.add("pointerDown", (ctx) => {
          const e = ctx.get("pointerState").raw;
          if (
            e.button === MOUSE_BUTTON.MAIN &&
            !this.contains(e.target as HTMLElement)
          ) {
            this.visible = false;
            this.hideCopilotPanel();
          }
        });
        this._listenClickOutsideId = null;
        this._clickOutsideOff = off;
      }, this);
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();

    this.selectionElem.className = "copilot-selection-rect";
    Object.assign(this.selectionElem.style, {
      position: "absolute",
      boxSizing: "border-box",
      borderRadius: "var(--mantine-radius-sm)",
      border:
        "calc(var(--mantine-scale) * 2px) dashed var(--myoxus-primary-color)",
    });
    this.selectionElem.hidden = true;
    this.append(this.selectionElem);
    const CopilotSelectionTool = this.gfx.tool.get(CopilotTool);

    this.disposables.add(
      CopilotSelectionTool.draggingAreaUpdated.subscribe((shouldShowPanel) => {
        this._visible = true;
        this._updateSelection(CopilotSelectionTool.area);
        if (shouldShowPanel) {
          this._showCopilotInput();
          this._watchClickOutside();
        } else {
          this.hideCopilotPanel();
        }
      }),
    );

    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => {
        if (!this._visible) return;

        this._updateSelection(CopilotSelectionTool.area);
      }),
    );

    this.disposables.add(
      effect(() => {
        const currentTool = this.gfx.tool.currentToolName$.value;

        if (!this._visible || currentTool === "copilot") return;

        this.visible = false;
        this.hideCopilotPanel();
      }),
    );

    this.disposables.add(() => {
      this.hideCopilotPanel();
      this.selectionElem.remove();
    });
  }

  determineInsertionBounds(width = 800, height = 95) {
    const elements = this.gfx.selection.selectedElements;
    const offsetY = 20 / this.gfx.viewport.zoom;
    const bounds = new Bound(0, 0, width, height);
    if (elements.length) {
      const { x, y, h } = getCommonBoundWithRotation(elements);
      bounds.x = x;
      bounds.y = y + h + offsetY;
    } else {
      const { x, y, height: h } = this.selectionModelRect;
      bounds.x = x;
      bounds.y = y + h + offsetY;
    }
    return bounds;
  }

  hideCopilotPanel() {
    this._copilotPanel?.remove();
    this._copilotPanel = null;
    this._autoUpdateCleanup?.();
    this._autoUpdateCleanup = null;
    if (this._listenClickOutsideId !== null)
      cancelAnimationFrame(this._listenClickOutsideId);
    this._listenClickOutsideId = null;
    this._clickOutsideOff?.();
    this._clickOutsideOff = null;
  }

  lockToolbar(disabled: boolean) {
    const legacySlot = this.std.get(EdgelessLegacySlotIdentifier);
    legacySlot.toolbarLocked.next(disabled);
  }

  private renderSelection() {
    const { x, y, width, height } = this._selectionRect;
    this.selectionElem.hidden = !this.visible;
    Object.assign(this.selectionElem.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  private _selectionRect = { x: 0, y: 0, width: 0, height: 0 };
  private _visible = false;
}

export const edgelessCopilotWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_EDGELESS_COPILOT_WIDGET,
  MYOXUS_EDGELESS_COPILOT_WIDGET,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_EDGELESS_COPILOT_WIDGET]: EdgelessCopilotWidget;
  }
}

export * from "./constant";
