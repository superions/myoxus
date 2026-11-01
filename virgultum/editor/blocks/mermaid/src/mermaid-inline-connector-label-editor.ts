// SPDX-License-Identifier: AGPL-3.0-or-later

import { mountConnectorLabelEditor } from "@virgultum/gfx-connector";
import type { ConnectorElementModel } from "@virgultum/model";
import type { BlockComponent } from "@virgultum/std";

type ObservableText = {
  observe(callback: () => void): void;
  toString(): string;
  unobserve(callback: () => void): void;
};

export type MermaidInlineConnectorLabelEditorHost = {
  getViewportElement(): Element | null;
  scheduleProjectionOwnerSourceSync(): void;
  setConnectorLabelEditActive(active: boolean): void;
};

function isObservableText(value: unknown): value is ObservableText {
  const text = value as Partial<ObservableText> | null | undefined;
  return (
    typeof text?.observe === "function" &&
    typeof text.toString === "function" &&
    typeof text.unobserve === "function"
  );
}

/**
 * Opens the native GFX connector-label editor for Mermaid owner connectors.
 *
 * Mermaid keeps source authoritative, but visible connector labels are user
 * content. This controller only bridges the existing GFX label editor to the
 * owner source-sync scheduler; it intentionally does not introduce a
 * Mermaid-specific label widget or toolbar-only editing path.
 */
export class MermaidInlineConnectorLabelEditorController {
  private static readonly connectorLabelEditorSelector =
    "edgeless-connector-label-editor";

  private readonly cleanups = new Map<string, () => void>();

  constructor(private readonly host: MermaidInlineConnectorLabelEditorHost) {}

  dispose() {
    this.host.setConnectorLabelEditActive(false);
    for (const cleanup of this.cleanups.values()) {
      cleanup();
    }
    this.cleanups.clear();
  }

  hasActiveEditor(editorHost?: Element | null) {
    return Boolean(
      (editorHost ?? this.host.getViewportElement())?.querySelector(
        MermaidInlineConnectorLabelEditorController.connectorLabelEditorSelector,
      ),
    );
  }

  start({
    connector,
    editorHost,
    point,
  }: {
    connector: ConnectorElementModel;
    editorHost: BlockComponent;
    point?: [number, number];
  }) {
    if (!editorHost.querySelector(".edgeless-mount-point")) {
      const mountPoint = document.createElement("div");
      mountPoint.className =
        "edgeless-mount-point myoxus-mermaid-inline-mount-point";
      editorHost.append(mountPoint);
    }

    if (this.hasActiveEditor(editorHost)) return;

    this.host.setConnectorLabelEditActive(true);
    try {
      mountConnectorLabelEditor(connector, editorHost, point);
    } catch (error) {
      this.host.setConnectorLabelEditActive(false);
      throw error;
    }
    this.focus(editorHost);
    this.observeTextEdit(connector, editorHost);
  }

  private focus(editorHost: BlockComponent, attempts = 0) {
    const connectorEditor = editorHost.querySelector(
      MermaidInlineConnectorLabelEditorController.connectorLabelEditorSelector,
    ) as
      | (HTMLElement & {
          updateComplete?: Promise<unknown>;
        })
      | null;
    const richText = connectorEditor?.querySelector("rich-text") as
      | (HTMLElement & {
          inlineEditor?: {
            focusEnd?: () => void;
            rootElement?: HTMLElement | null;
          };
        })
      | null;
    const inlineEditor =
      richText?.inlineEditor?.rootElement ??
      (connectorEditor?.querySelector(".inline-editor") as HTMLElement | null);

    richText?.inlineEditor?.focusEnd?.();
    inlineEditor?.focus({ preventScroll: true });
    if (
      inlineEditor &&
      (document.activeElement === inlineEditor ||
        inlineEditor.contains(document.activeElement))
    ) {
      return;
    }
    if (attempts >= 16) return;

    requestAnimationFrame(() => this.focus(editorHost, attempts + 1));
    connectorEditor?.updateComplete
      ?.then(() => this.focus(editorHost, attempts + 1))
      .catch(console.error);
  }

  private observeTextEdit(
    connector: ConnectorElementModel,
    editorHost: BlockComponent,
    attempts = 0,
  ) {
    this.cleanups.get(connector.id)?.();
    const text = connector.text;
    if (!isObservableText(text)) {
      if (attempts < 4) {
        setTimeout(
          () => this.observeTextEdit(connector, editorHost, attempts + 1),
          0,
        );
      }
      return;
    }

    const syncLabelToSource = () => {
      this.host.setConnectorLabelEditActive(false);
      this.host.scheduleProjectionOwnerSourceSync();
    };
    const restoreViewportFocus = () => {
      queueMicrotask(() => {
        const viewport = this.host.getViewportElement();
        if (viewport instanceof HTMLElement && viewport.isConnected) {
          viewport.focus({ preventScroll: true });
        }
      });
    };
    const mutationObserver = new MutationObserver(() => {
      if (!this.hasActiveEditor(editorHost)) {
        syncLabelToSource();
        cleanup();
        restoreViewportFocus();
      }
    });
    mutationObserver.observe(editorHost, { childList: true, subtree: true });

    const timeout = setTimeout(() => {
      syncLabelToSource();
      cleanup();
    }, 30_000);

    const cleanup = () => {
      mutationObserver.disconnect();
      clearTimeout(timeout);
      this.cleanups.delete(connector.id);
    };
    this.cleanups.set(connector.id, cleanup);
  }
}
