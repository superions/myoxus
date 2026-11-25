// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import {
  type PropsWithChildren,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";

import { useEditorColorScheme } from "./embedded-ui-root";

function getOrCreateOverlayHost(
  id: string,
  colorScheme: "dark" | "light" | undefined,
): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  const existing = document.querySelector<HTMLDivElement>(
    `[data-myoxus-mermaid-overlay-root="${CSS.escape(id)}"]`,
  );
  if (existing) {
    if (colorScheme) {
      existing.dataset.theme = colorScheme;
    } else {
      delete existing.dataset.theme;
    }
    return existing;
  }
  const host = document.createElement("div");
  host.setAttribute("data-myoxus-mermaid-overlay-root", id);
  host.setAttribute("data-range-sync-exclude", "true");
  if (colorScheme) {
    host.dataset.theme = colorScheme;
  }
  document.body.append(host);
  return host;
}

/**
 * Shared portal for Mermaid runtime overlays, markers, and drag handles.
 * Keeps fixed-coordinate geometry unclipped by transformed/scrolled editor
 * ancestors while preserving the active MantineProvider/EditorEmbeddedUIRoot
 * color scheme.
 */
export function MermaidRuntimePortal({
  children,
  target,
}: PropsWithChildren<{ target?: HTMLElement | null }>) {
  const colorScheme = useEditorColorScheme();
  const id = useId();
  const managedHost = useMemo(
    () => (target ? null : getOrCreateOverlayHost(id, colorScheme)),
    [target, id, colorScheme],
  );

  useEffect(() => {
    if (!managedHost) return;
    if (colorScheme) {
      managedHost.dataset.theme = colorScheme;
    } else {
      delete managedHost.dataset.theme;
    }
  }, [managedHost, colorScheme]);

  useEffect(() => {
    if (!managedHost) return;
    if (!managedHost.isConnected && document.body) {
      document.body.append(managedHost);
    }
    return () => {
      managedHost.remove();
    };
  }, [managedHost]);

  const getRootElement = useCallback(
    () => managedHost ?? target ?? undefined,
    [managedHost, target],
  );

  const portalTarget = target ?? managedHost;
  if (!portalTarget) return null;

  const content =
    !target && colorScheme && managedHost ? (
      <MyoxusEmbeddedUIProvider
        colorScheme={colorScheme}
        cssVariablesSelector={`[data-myoxus-mermaid-overlay-root="${id}"]`}
        getRootElement={getRootElement}
      >
        {children}
      </MyoxusEmbeddedUIProvider>
    ) : (
      children
    );

  return createPortal(content, portalTarget);
}

export type MermaidCaptureDragHandlers = {
  onMove: (event: PointerEvent) => void;
  onUp: (event: PointerEvent) => void;
  onCancel?: (event?: PointerEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onCleanup?: () => void;
};

/**
 * Shared capture-phase document pointer-drag session with guaranteed cleanup
 * on pointerup, pointercancel, Escape/keydown, re-entry, and unmount.
 */
export function useMermaidCaptureDrag() {
  const activeCleanupRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    activeCleanupRef.current?.();
  }, []);

  useEffect(() => () => activeCleanupRef.current?.(), []);

  const start = useCallback((handlers: MermaidCaptureDragHandlers) => {
    activeCleanupRef.current?.();
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", pointerCancel, true);
      if (keyDown) {
        document.removeEventListener("keydown", keyDown, true);
      }
      if (activeCleanupRef.current === cleanup) {
        activeCleanupRef.current = null;
      }
      handlers.onCleanup?.();
    };

    const move = (event: PointerEvent) => {
      if (cleaned) return;
      handlers.onMove(event);
    };

    const up = (event: PointerEvent) => {
      if (cleaned) return;
      handlers.onUp(event);
    };

    const pointerCancel = (event: PointerEvent) => {
      if (cleaned) return;
      if (handlers.onCancel) {
        handlers.onCancel(event);
      } else {
        cleanup();
      }
    };

    const keyDown = handlers.onKeyDown
      ? (event: KeyboardEvent) => {
          if (cleaned) return;
          handlers.onKeyDown?.(event);
        }
      : null;

    activeCleanupRef.current = cleanup;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    if (keyDown) {
      document.addEventListener("keydown", keyDown, true);
    }

    return cleanup;
  }, []);

  return { start, cancel };
}
