import { Bound } from "@virgultum/global/gfx";
import type { ShapeElementModel } from "@virgultum/model";
import { getFontString, wrapText } from "@virgultum/gfx-text";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/std/inline";
import * as Y from "yjs";

import { MERMAID_INLINE_NODE_EDITOR_CLASS } from "./mermaid-editor-events.js";
import { syncMermaidGfxNodeLabelsFromVisibleText } from "./mermaid-gfx-metadata.js";
import { mermaidMessages } from "./i18n.js";
import {
  mermaidGfxTypographyForNode,
  resolveMermaidGfxTheme,
} from "./mermaid-gfx-theme.js";

export type MermaidInlineShapeTextEditorHost = {
  getViewportElement(): Element | null;
  scheduleProjectionOwnerSourceSync(): void;
  toViewPoint(x: number, y: number): { left: number; top: number } | null;
};

type ActiveShapeEditor = {
  cleanup: () => void;
  commitValue?: (value: string) => boolean;
  dirty: boolean;
  input: HTMLInputElement | HTMLTextAreaElement;
  model: ShapeElementModel;
  onClose?: () => void;
  originalValue: string;
  initialValue: string;
  originalTextDisplay: boolean;
  resolveModel: () => ShapeElementModel | null;
  syncNodeMetadata: boolean;
};

/**
 * Owns direct Mermaid node-label editing in the scoped GFX viewport.
 *
 * The native Edgeless shape text editor remounts RichText internals while a
 * scoped Mermaid surface is updating and can close after the first typed
 * character. Mermaid labels only need a single semantic text value, so this
 * controller uses a stable viewport overlay and commits that value back into
 * the existing GFX/Y.Text model before the normal owner source sync.
 */
export class MermaidInlineShapeTextEditorController {
  private active: ActiveShapeEditor | null = null;

  constructor(private readonly host: MermaidInlineShapeTextEditorHost) {}

  dispose() {
    this.close({ cancel: true, restoreFocus: false });
  }

  hasActiveEditor() {
    return Boolean(this.active?.input.isConnected);
  }

  start({
    commitValue,
    initialValue,
    model,
    onClose,
    resolveModel = () => model,
    syncNodeMetadata = true,
    ariaLabel = mermaidMessages.selectedNodeLabel(),
    verticalPlacement = "full-shape",
  }: {
    ariaLabel?: string;
    commitValue?: (value: string) => boolean;
    initialValue?: string;
    model: ShapeElementModel;
    onClose?: () => void;
    resolveModel?: () => ShapeElementModel | null;
    syncNodeMetadata?: boolean;
    verticalPlacement?: "full-shape" | "top-line";
  }) {
    this.close({ cancel: true, restoreFocus: false });
    const viewport = this.host.getViewportElement();
    if (!(viewport instanceof HTMLElement)) return;
    const editorLayer = viewport.querySelector(
      ".myoxus-mermaid-inline-shape-editor-layer",
    );
    if (!(editorLayer instanceof HTMLElement)) return;

    const currentModel = resolveModel() ?? model;
    const theme = resolveMermaidGfxTheme();
    const typography = mermaidGfxTypographyForNode(currentModel, theme);
    const box = this.resolveEditorBox(
      currentModel,
      verticalPlacement === "top-line"
        ? typography.lineHeight + currentModel.padding[0] * 2
        : undefined,
    );
    const hasViewportExtent =
      viewport.clientWidth > 0 && viewport.clientHeight > 0;
    if (
      !box ||
      (hasViewportExtent &&
        (box.left + box.width <= 0 ||
          box.top + box.height <= 0 ||
          box.left >= viewport.clientWidth ||
          box.top >= viewport.clientHeight))
    ) {
      return;
    }

    const projectedLabel =
      verticalPlacement === "full-shape" && currentModel.labelProjection;
    // Projected captions can contain semantic line breaks. A text input strips
    // them on assignment, even before the user has changed a single character.
    const input = document.createElement(projectedLabel ? "textarea" : "input");
    input.className = MERMAID_INLINE_NODE_EDITOR_CLASS;
    input.value = initialValue ?? currentModel.text?.toString?.() ?? "";
    input.setAttribute("aria-label", ariaLabel);
    input.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    input.style.left = `${box.left}px`;
    input.style.top = `${box.top}px`;
    input.style.width = `${box.width}px`;
    input.style.height = `${box.height}px`;
    input.style.backgroundColor = projectedLabel
      ? "transparent"
      : theme.surfaceColor;
    input.style.color = theme.textColor;
    const font = getFontString({
      ...typography,
      fontSize: typography.fontSize * box.scale,
    });
    input.style.font = font;
    input.style.letterSpacing = `${typography.letterSpacing * box.scale}px`;
    input.style.lineHeight = `${typography.lineHeight * box.scale}px`;
    input.style.padding = projectedLabel
      ? "0"
      : `${currentModel.padding[0] * box.scale}px ${currentModel.padding[1] * box.scale}px`;
    if (projectedLabel) {
      input.style.border = "none";
      input.style.resize = "none";
      input.style.overflow = "hidden";
    }
    input.style.textAlign = currentModel.textAlign;
    const positionDraft = () => {
      if (!projectedLabel) return;
      // Match the Canvas block's vertical centering as the draft gains or loses
      // wrapped lines; committing must not make the caption jump within its shape.
      const lines = wrapText(input.value, font, box.width).split("\n").length;
      input.style.paddingTop = `${Math.max(0, (box.height - lines * typography.lineHeight * box.scale) / 2)}px`;
    };
    positionDraft();

    const stop = (event: Event) => {
      event.stopPropagation();
    };
    const commitFromKeyboard = () =>
      this.close({ cancel: false, restoreFocus: true });
    const cancelFromKeyboard = () =>
      this.close({ cancel: true, restoreFocus: true });
    const onInput = (event: Event) => {
      event.stopPropagation();
      positionDraft();
      const value = input.value.trim();
      const currentModel = resolveModel() ?? model;
      // Semantic hosts own the accepted Source/history mutation. Their draft
      // must not wake collaborative geometry and viewport observers per key.
      if (!commitValue) {
        this.writeModelText(currentModel, value);
        if (syncNodeMetadata) {
          syncMermaidGfxNodeLabelsFromVisibleText(currentModel, value);
        }
      }
      if (this.active?.input === input) this.active.dirty = true;
    };
    const onKeydown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      event.stopPropagation();
      if (event.key !== "Enter" && event.key !== "Escape") return;
      if (event.key === "Enter" && event.shiftKey && projectedLabel) return;
      event.preventDefault();
      if (event.key === "Escape") cancelFromKeyboard();
      else commitFromKeyboard();
    };
    const onBlur = () => this.close({ cancel: false, restoreFocus: false });
    const onDocumentPointerdown = (event: PointerEvent) => {
      if (event.target instanceof Node && input.contains(event.target)) return;
      this.close({ cancel: false, restoreFocus: false });
    };

    input.addEventListener("click", stop);
    input.addEventListener("dblclick", stop);
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("keyup", stop);
    input.addEventListener("pointerdown", stop);
    input.addEventListener("blur", onBlur);
    const nativeEditingEvents = [
      "paste",
      "copy",
      "cut",
      "beforeinput",
      "compositionstart",
      "compositionend",
    ];
    for (const event of nativeEditingEvents)
      input.addEventListener(event, stop);
    document.addEventListener("pointerdown", onDocumentPointerdown, true);

    const originalTextDisplay = currentModel.textDisplay;
    this.active = {
      cleanup: () => {
        input.removeEventListener("click", stop);
        input.removeEventListener("dblclick", stop);
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown);
        input.removeEventListener("keyup", stop);
        input.removeEventListener("pointerdown", stop);
        input.removeEventListener("blur", onBlur);
        for (const event of nativeEditingEvents)
          input.removeEventListener(event, stop);
        document.removeEventListener(
          "pointerdown",
          onDocumentPointerdown,
          true,
        );
        input.remove();
      },
      commitValue,
      dirty: false,
      input,
      model: currentModel,
      onClose,
      originalValue: currentModel.text?.toString?.() ?? "",
      initialValue: input.value,
      originalTextDisplay,
      resolveModel,
      syncNodeMetadata,
    };

    // Install the editing state before Surface observers see the visibility
    // change, so local appearance refresh cannot paint the old caption again.
    editorLayer.append(input);
    currentModel.textDisplay = false;
    input.focus({ preventScroll: true });
    input.select();
  }

  private close({
    cancel,
    restoreFocus,
  }: {
    cancel: boolean;
    restoreFocus: boolean;
  }) {
    const active = this.active;
    if (!active) return;
    this.active = null;
    const value = active.input.value.trim();
    const currentModel = active.resolveModel() ?? active.model;
    const restoreOriginalModelValue = () => {
      this.writeModelText(currentModel, active.originalValue);
      if (active.syncNodeMetadata) {
        syncMermaidGfxNodeLabelsFromVisibleText(
          currentModel,
          active.originalValue,
        );
      }
    };
    // Detail previews without a semantic host still need rollback on Cancel.
    // Host-owned drafts have not touched Y.Text and must not overwrite it here.
    if (cancel && !active.commitValue) restoreOriginalModelValue();
    active.cleanup();
    currentModel.textDisplay = active.originalTextDisplay;
    const shouldCommit =
      !cancel && active.dirty && value !== active.initialValue.trim();
    const committedByHost = shouldCommit && active.commitValue?.(value);
    if (shouldCommit && !committedByHost) {
      this.writeModelText(currentModel, value);
      if (active.syncNodeMetadata) {
        syncMermaidGfxNodeLabelsFromVisibleText(currentModel, value);
      }
      this.host.scheduleProjectionOwnerSourceSync();
    }
    if (restoreFocus) {
      const viewport = this.host.getViewportElement();
      if (viewport instanceof HTMLElement && viewport.isConnected) {
        viewport.focus({ preventScroll: true });
      }
    }
    active.onClose?.();
  }

  private resolveEditorBox(model: ShapeElementModel, modelHeight?: number) {
    let bound = Bound.deserialize(model.xywh);
    if (modelHeight === undefined && model.labelProjection) {
      const box = model.labelProjection.box;
      bound = new Bound(
        bound.x + box.x,
        bound.y + box.y,
        box.width,
        box.height,
      );
    }
    const start = this.host.toViewPoint(bound.x, bound.y);
    const end = this.host.toViewPoint(bound.x + bound.w, bound.y + bound.h);
    if (!start || !end) return null;
    const fullHeight = Math.abs(end.top - start.top);
    const width = Math.abs(end.left - start.left);
    if (fullHeight <= 0 || width <= 0 || bound.w <= 0) return null;
    const scale = Math.max(width / bound.w, Number.EPSILON);
    return {
      height: Math.min(fullHeight, (modelHeight ?? bound.h) * scale),
      left: Math.min(start.left, end.left),
      scale,
      top: Math.min(start.top, end.top),
      width,
    };
  }

  private writeModelText(model: ShapeElementModel, value: string) {
    const text = model.text instanceof Y.Text ? model.text : new Y.Text();
    text.delete(0, text.length);
    text.insert(0, value);
    if (model.text !== text) {
      model.text = text;
    }
  }
}
