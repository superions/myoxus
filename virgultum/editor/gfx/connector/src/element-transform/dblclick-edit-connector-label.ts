import { ConnectorElementModel } from "@virgultum/model";
import {
  type GfxInteractivityContext,
  InteractivityExtension,
} from "@virgultum/std/gfx";

import { mountConnectorLabelEditor } from "../text";

export class DblClickEditConnectorLabel extends InteractivityExtension {
  static override key = "dbl-click-edit-connector-label";

  private _lastClick: {
    connectorId: string;
    timeStamp: number;
    x: number;
    y: number;
  } | null = null;

  override mounted() {
    this.event.on("dblclick", (ctx: GfxInteractivityContext) => {
      this._openConnectorLabelEditor(ctx);
      setTimeout(() => this._openSelectedConnectorLabelEditor(ctx), 50);
    });

    this.event.on("click", (ctx: GfxInteractivityContext) => {
      const connector = this._getEditableConnector(ctx);
      if (!connector) {
        this._lastClick = null;
        return;
      }

      const lastClick = this._lastClick;
      this._lastClick = {
        connectorId: connector.id,
        timeStamp: ctx.event.raw.timeStamp,
        x: ctx.event.raw.clientX,
        y: ctx.event.raw.clientY,
      };

      if (
        !lastClick ||
        lastClick.connectorId !== connector.id ||
        ctx.event.raw.timeStamp - lastClick.timeStamp > 500 ||
        Math.hypot(
          ctx.event.raw.clientX - lastClick.x,
          ctx.event.raw.clientY - lastClick.y,
        ) > 8
      ) {
        return;
      }

      this._openConnectorLabelEditor(ctx, connector);
      setTimeout(() => this._openSelectedConnectorLabelEditor(ctx), 50);
    });
  }

  private _openConnectorLabelEditor(
    ctx: GfxInteractivityContext,
    connector = this._getEditableConnector(ctx),
  ): void {
    if (!connector) {
      return;
    }

    const edgeless = this.std.view.getBlock(this.std.store.root?.id ?? "");
    if (!edgeless) {
      return;
    }

    ctx.preventDefault();
    mountConnectorLabelEditor(
      connector,
      edgeless,
      this.gfx.viewport.toModelCoord(ctx.event.x, ctx.event.y),
    );
  }

  private _openSelectedConnectorLabelEditor(
    ctx: GfxInteractivityContext,
  ): void {
    const selected = this.gfx.selection.selectedElements;
    if (selected.length !== 1) {
      return;
    }

    const connector = selected[0];
    if (
      !(connector instanceof ConnectorElementModel) ||
      connector.isLocked() ||
      connector.labelEditing
    ) {
      return;
    }

    this._openConnectorLabelEditor(ctx, connector);
  }

  private _getEditableConnector(
    ctx: GfxInteractivityContext,
  ): ConnectorElementModel | null {
    const [x, y] = this.gfx.viewport.toModelCoord(ctx.event.x, ctx.event.y);
    const hitCandidates = this.gfx.getElementByPoint(x, y, { all: true });

    for (let i = hitCandidates.length - 1; i >= 0; i--) {
      const candidate = hitCandidates[i];
      if (
        candidate instanceof ConnectorElementModel &&
        !candidate.isLocked() &&
        !candidate.labelEditing
      ) {
        return candidate;
      }
    }

    const selected = this.gfx.selection.selectedElements;
    if (selected.length !== 1) {
      return null;
    }

    const connector = selected[0];
    if (
      !(connector instanceof ConnectorElementModel) ||
      connector.isLocked() ||
      connector.labelEditing
    ) {
      return null;
    }

    return connector.includesPoint(x, y, {
      hitThreshold: 20,
      responsePadding: [5, 5],
      zoom: this.gfx.viewport.zoom,
    })
      ? connector
      : null;
  }
}
