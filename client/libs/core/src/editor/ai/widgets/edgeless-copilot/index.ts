// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import { popoverViewportMiddlewares } from "@myoxus/ui-facade";
import { effect, signal } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/editor/blocks/surface";
import {
  Bound,
  getCommonBoundWithRotation,
} from "@virgultum/editor/global/gfx";
import type { RootBlockModel } from "@virgultum/editor/model";
import {
  MOUSE_BUTTON,
  requestConnectedFrame,
  stopPropagation,
} from "@virgultum/editor/shared/utils";
import { NativeEditorWidget, WidgetViewExtension } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { createElement, type ReactNode } from "react";

import type { AIItemGroupConfig } from "../../components/ai-item/types";
import { AIProvider } from "../../provider";
import { extractSelectedContent } from "../../utils/extract";
import { AIPanelControllerIdentifier } from "../ai-panel/controller";
import { AIActionMenu } from "../ai-panel/view";
import { NativeAIWidgetUI } from "../native-ui";
import { MYOXUS_EDGELESS_COPILOT_WIDGET } from "./constant";

const PANEL_VIEWPORT_PADDING = {
  top: 10,
  right: 10,
  bottom: 150,
  left: 10,
};

interface MountedActionPanel {
  container: HTMLDivElement;
  dispose: () => void;
}

export class EdgelessCopilotWidget extends NativeEditorWidget<RootBlockModel> {
  readonly selectionElem = document.createElement("div");

  groups: AIItemGroupConfig[] = [];

  private _selectionRect = { x: 0, y: 0, width: 0, height: 0 };
  private _selectionModelRect = new DOMRect();
  private _visible = false;
  private _mountedPanel: MountedActionPanel | null = null;
  private _positionCleanup: (() => void) | null = null;
  private _outsideClickOff: (() => void) | null = null;
  private _outsideClickFrame: number | null = null;

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
    return Boolean(
      this._visible && this._selectionRect.width && this._selectionRect.height,
    );
  }

  set visible(nextVisible: boolean) {
    this._visible = nextVisible;
    this.syncSelectionBox();
  }

  setCopilotPanelVisible(visible: boolean): void {
    const container = this._mountedPanel?.container;
    if (container) {
      container.style.visibility = visible ? "visible" : "hidden";
    }
  }

  private openCopilotInput() {
    requestConnectedFrame(() => {
      if (!this.selectionElem.isConnected) return;

      const aiPanel = this.std.getOptional(AIPanelControllerIdentifier);
      if (!aiPanel) return;

      aiPanel.setState("input", this.selectionElem);

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
          this.setCopilotPanelVisible(!text);
        };
      }

      requestAnimationFrame(() => {
        const panel = this.mountActionPanel();
        if (panel) {
          this.positionActionPanel(panel.container, aiPanel.element);
        }
      });
    }, this);
  }

  private mountActionPanel(): MountedActionPanel | null {
    if (this._mountedPanel) {
      return this._mountedPanel;
    }

    const mount = this.host.std.getOptional(NativeAIWidgetUI);
    if (!mount) return null;

    const chain = this.host.std.command.chain();
    const visibleGroups = this.groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          item.showWhen?.(chain, "edgeless", this.host),
        ),
      }))
      .filter((group) => group.items.length > 0);

    if (visibleGroups.length === 0) return null;

    const container = document.createElement("div");
    container.dataset.myoxusUiRole = "edgeless-copilot-panel";
    container.style.position = "absolute";
    container.style.zIndex = "var(--myoxus-z-index-popover)";

    const listenerAbort = new AbortController();
    for (const eventName of ["wheel", "pointerdown"] as const) {
      container.addEventListener(eventName, stopPropagation, {
        signal: listenerAbort.signal,
      });
    }

    this.append(container);
    const unmountReact = mount(
      container,
      signal<ReactNode>(
        createElement(AIActionMenu, {
          host: this.host,
          groups: visibleGroups,
          maxHeight: "floating",
        }),
      ),
    );

    const mounted: MountedActionPanel = {
      container,
      dispose: () => {
        listenerAbort.abort();
        unmountReact();
        container.remove();
      },
    };
    this._mountedPanel = mounted;
    return mounted;
  }

  private positionActionPanel(
    panelEl: HTMLElement,
    anchorEl: HTMLElement,
  ): void {
    this._positionCleanup?.();
    this._positionCleanup = autoUpdate(anchorEl, panelEl, () => {
      computePosition(anchorEl, panelEl, {
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
          size({
            ...popoverViewportMiddlewares.size,
            padding: PANEL_VIEWPORT_PADDING,
          }),
          shift({
            padding: PANEL_VIEWPORT_PADDING,
            limiter: limitShift(),
          }),
        ],
      })
        .then(({ x, y }) => {
          panelEl.style.left = `${x}px`;
          panelEl.style.top = `${y}px`;
        })
        .catch((err) => {
          console.warn("Unable to position Edgeless copilot action menu", err);
        });
    });
  }

  private updateSelectionArea(rect: DOMRect) {
    this._selectionModelRect = rect;
    const zoom = this.gfx.viewport.zoom;
    const [x, y] = this.gfx.viewport.toViewCoord(rect.left, rect.top);
    this._selectionRect = {
      x,
      y,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
    this.syncSelectionBox();
  }

  private armOutsideDismiss() {
    this._outsideClickOff?.();
    if (!this._selectionRect.width || !this._selectionRect.height) return;

    if (this._outsideClickFrame !== null) {
      cancelAnimationFrame(this._outsideClickFrame);
    }

    this._outsideClickFrame = requestConnectedFrame(() => {
      if (!this.isConnected) return;
      this._outsideClickOff = this.std.event.add("pointerDown", (ctx) => {
        const raw = ctx.get("pointerState").raw;
        if (
          raw.button === MOUSE_BUTTON.MAIN &&
          !this.contains(raw.target as Node | null)
        ) {
          this.visible = false;
          this.hideCopilotPanel();
        }
      });
      this._outsideClickFrame = null;
    }, this);
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

    const copilotTool = this.gfx.tool.get(CopilotTool);

    this.disposables.add(
      copilotTool.draggingAreaUpdated.subscribe((shouldShowPanel) => {
        this._visible = true;
        this.updateSelectionArea(copilotTool.area);
        if (shouldShowPanel) {
          this.openCopilotInput();
          this.armOutsideDismiss();
        } else {
          this.hideCopilotPanel();
        }
      }),
    );

    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => {
        if (this._visible) {
          this.updateSelectionArea(copilotTool.area);
        }
      }),
    );

    this.disposables.add(
      effect(() => {
        const activeTool = this.gfx.tool.currentToolName$.value;
        if (!this._visible || activeTool === "copilot") return;
        this.visible = false;
        this.hideCopilotPanel();
      }),
    );

    this.disposables.add(() => {
      this.hideCopilotPanel();
      this.selectionElem.remove();
    });
  }

  determineInsertionBounds(width = 800, height = 95): Bound {
    const selected = this.gfx.selection.selectedElements;
    const gapY = 20 / this.gfx.viewport.zoom;
    const bounds = new Bound(0, 0, width, height);

    if (selected.length > 0) {
      const { x, y, h } = getCommonBoundWithRotation(selected);
      bounds.x = x;
      bounds.y = y + h + gapY;
    } else {
      const { x, y, height: h } = this.selectionModelRect;
      bounds.x = x;
      bounds.y = y + h + gapY;
    }
    return bounds;
  }

  hideCopilotPanel(): void {
    this._mountedPanel?.dispose();
    this._mountedPanel = null;
    this._positionCleanup?.();
    this._positionCleanup = null;

    if (this._outsideClickFrame !== null) {
      cancelAnimationFrame(this._outsideClickFrame);
      this._outsideClickFrame = null;
    }
    this._outsideClickOff?.();
    this._outsideClickOff = null;
  }

  lockToolbar(disabled: boolean): void {
    const legacySlot = this.std.get(EdgelessLegacySlotIdentifier);
    legacySlot.toolbarLocked.next(disabled);
  }

  private syncSelectionBox(): void {
    const { x, y, width, height } = this._selectionRect;
    this.selectionElem.hidden = !this.visible;
    Object.assign(this.selectionElem.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }
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
