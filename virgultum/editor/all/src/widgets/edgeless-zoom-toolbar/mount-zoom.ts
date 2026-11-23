// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { BlockStdScope } from "@virgultum/core/runtime";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";

import { ZoomController } from "./zoom-controller";

export function mountCanvasZoom(std: BlockStdScope, overlay: HTMLElement) {
  const mount = std.getOptional(EditorChromeHostIdentifier)?.mountZoom;
  if (!mount) return;

  // Canvas owns the overlay coordinates. The facade owns the controls.
  const anchor = overlay.ownerDocument.createElement("div");
  anchor.dataset.canvasZoom = "";
  Object.assign(anchor.style, {
    position: "absolute",
    left: "var(--mantine-spacing-sm)",
    bottom: "var(--mantine-spacing-md)",
    zIndex: "var(--myoxus-z-index-popover)",
  });
  overlay.append(anchor);

  const controls = new ZoomController(std);
  const unmount = mount(anchor, controls);
  return () => {
    unmount();
    controls.dispose();
    anchor.remove();
  };
}
