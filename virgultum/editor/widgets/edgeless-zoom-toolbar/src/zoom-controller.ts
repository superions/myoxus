// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/block-surface";
import { DisposableGroup } from "@virgultum/global/disposable";
import type { BlockStdScope } from "@virgultum/std";
import {
  GfxControllerIdentifier,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from "@virgultum/std/gfx";

import type { EditorZoomState } from "@virgultum/shared/services";

/** One viewport subscription owner; controls never retain a document selection. */
export class ZoomController {
  private readonly disposables = new DisposableGroup();
  private readonly listeners = new Set<() => void>();
  private hidden = false;
  private disposed = false;
  private snapshot: EditorZoomState;
  private readonly gfx;

  constructor(readonly std: BlockStdScope) {
    this.gfx = std.get(GfxControllerIdentifier);
    this.snapshot = this.readState();
    const slots = std.get(EdgelessLegacySlotIdentifier);
    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(this.refresh),
    );
    this.disposables.add(slots.readonlyUpdated.subscribe(this.refresh));
    this.disposables.add(
      slots.navigatorSettingUpdated.subscribe(({ hideToolbar }) => {
        if (hideToolbar !== undefined) this.hidden = hideToolbar;
        this.refresh();
      }),
    );
    this.disposables.add(
      effect(() => {
        if (this.gfx.tool.currentToolName$.value !== "frameNavigator")
          this.hidden = false;
        this.refresh();
      }),
    );
  }

  private readState(): EditorZoomState {
    return {
      zoom: this.gfx.viewport.zoom,
      locked: this.gfx.viewport.locked,
      visible: !this.hidden && !this.std.store.readonly,
    };
  }

  private readonly refresh = () => {
    const next = this.readState();
    if (
      next.zoom === this.snapshot.zoom &&
      next.locked === this.snapshot.locked &&
      next.visible === this.snapshot.visible
    )
      return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  };

  // Stable snapshots let React and retained Lit views share one state owner.
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly setZoom = (zoom: number) => {
    if (this.disposed || !this.readState().visible || this.gfx.viewport.locked)
      return;
    this.gfx.viewport.smoothZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)));
  };
  readonly step = (direction: -1 | 1) =>
    this.setZoom(this.gfx.viewport.zoom + direction * ZOOM_STEP);
  readonly fit = () => {
    if (!this.disposed && this.readState().visible && !this.gfx.viewport.locked)
      this.gfx.fitToScreen();
  };

  dispose() {
    this.disposed = true;
    this.disposables.dispose();
    this.listeners.clear();
  }
}
