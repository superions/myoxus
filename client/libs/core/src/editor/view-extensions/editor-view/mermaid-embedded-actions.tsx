// SPDX-License-Identifier: AGPL-3.0-or-later

import { CanvasOverlayToolbar, ToolbarSurface } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function MermaidEmbeddedActions({
  actions,
  label,
  placement = "bottom-overlay",
  concealed = false,
}: {
  readonly actions: ReactNode;
  readonly label: string;
  readonly placement?: "inline" | "bottom-overlay";
  readonly concealed?: boolean;
}) {
  return (
    <CanvasOverlayToolbar
      aria-hidden={concealed || undefined}
      inert={concealed}
      // Keep the measured safe inset stable while an inline draft owns input.
      style={concealed ? { visibility: "hidden" } : undefined}
    >
      <ToolbarSurface
        aria-label={label}
        compact
        justify="flex-start"
        data-myoxus-ui-role="mermaid-embedded-actions"
        placement={placement}
        role="toolbar"
      >
        {actions}
      </ToolbarSurface>
    </CanvasOverlayToolbar>
  );
}
