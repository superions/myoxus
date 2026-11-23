// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { EditPropsStore } from "@virgultum/core/services";

import { EdgelessFrameManagerIdentifier } from "../frame-manager";
import { PresentTool } from "../present-tool";

export function mountPresentationBackground(
  anchor: HTMLElement,
  std: BlockStdScope,
) {
  if (!std.getOptional(EdgelessFrameManagerIdentifier)) return;
  const { viewport, tool } = std.get(GfxControllerIdentifier);
  const slots = std.get(EdgelessLegacySlotIdentifier);
  const preferences = std.get(EditPropsStore);
  const background = anchor.ownerDocument.createElement("div");
  background.className = "edgeless-navigator-black-background";
  background.setAttribute("aria-hidden", "true");
  let activeFrame: FrameBlockModel | undefined;
  let enabled = preferences.getStorage("presentBlackBackground") ?? true;
  let presenting = false;
  const paint = () => {
    if (!enabled || !activeFrame || !presenting) {
      background.remove();
      return;
    }
    const { x, y, w, h } = activeFrame.elementBound;
    const [left, top] = viewport.toViewCoord(x, y);
    Object.assign(background.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${w * viewport.zoom}px`,
      height: `${h * viewport.zoom}px`,
    });
    if (!background.parentElement) anchor.prepend(background);
  };
  const disposables = new DisposableGroup();
  let stopFrame: (() => void) | undefined;
  disposables.add(
    slots.navigatorFrameChanged.subscribe((frame) => {
      stopFrame?.();
      activeFrame = frame;
      const change = frame?.propsUpdated.subscribe(paint);
      stopFrame = change && (() => change.unsubscribe());
      paint();
    }),
  );
  disposables.add(
    slots.navigatorSettingUpdated.subscribe(({ blackBackground }) => {
      if (blackBackground === undefined) return;
      enabled = blackBackground;
      preferences.setStorage("presentBlackBackground", blackBackground);
      paint();
    }),
  );
  disposables.add(viewport.viewportUpdated.subscribe(paint));
  disposables.add(
    effect(() => {
      presenting = tool.currentToolName$.value === PresentTool.toolName;
      paint();
    }),
  );
  disposables.add(() => {
    stopFrame?.();
    background.remove();
  });
  return disposables;
}
