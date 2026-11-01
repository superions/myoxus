import type { MermaidShellMode } from "./families/runtime/shell-contract.js";

export type MermaidKeyboardIntent =
  | "delete-selection"
  | "ignore"
  | "redo"
  | "undo"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset";

type MermaidKeyboardBaseInput = {
  altKey: boolean;
  code?: string;
  ctrlKey: boolean;
  hasActiveBlockTarget?: boolean;
  hasActiveInlineShapeTextEditor: boolean;
  hasEditableTarget: boolean;
  key: string;
  metaKey: boolean;
  mode: MermaidShellMode;
  shiftKey: boolean;
};

export function shouldReadMermaidKeyboardSelection({
  altKey,
  ctrlKey,
  hasActiveInlineShapeTextEditor,
  hasEditableTarget,
  key,
  metaKey,
  mode,
  shiftKey,
}: MermaidKeyboardBaseInput): boolean {
  if (hasEditableTarget || hasActiveInlineShapeTextEditor) return false;

  const normalizedKey = key.toLowerCase();
  return Boolean(
    mode === "visual" &&
    !ctrlKey &&
    !metaKey &&
    !altKey &&
    !shiftKey &&
    (normalizedKey === "delete" || normalizedKey === "backspace"),
  );
}

export function resolveMermaidKeyboardIntent({
  hasVisualSelection,
  ...input
}: MermaidKeyboardBaseInput & {
  hasVisualSelection: boolean;
}): MermaidKeyboardIntent {
  if (input.hasEditableTarget || input.hasActiveInlineShapeTextEditor) {
    return "ignore";
  }

  if (shouldReadMermaidKeyboardSelection(input)) {
    return hasVisualSelection ? "delete-selection" : "ignore";
  }

  const normalizedKey = input.key.toLowerCase();
  if (!(input.ctrlKey || input.metaKey) || input.altKey) return "ignore";

  if (input.mode !== "source" && input.hasActiveBlockTarget) {
    if (
      normalizedKey === "+" ||
      input.code === "Equal" ||
      input.code === "NumpadAdd"
    ) {
      return "zoom-in";
    }
    if (normalizedKey === "-" || input.code === "NumpadSubtract") {
      return "zoom-out";
    }
    if (normalizedKey === "0" || input.code === "Numpad0") {
      return "zoom-reset";
    }
  }

  // View is a read-only projection of the current diagram. History remains
  // available in Visual and Source, but a focused View must never turn the
  // document-level shortcut into a hidden diagram mutation.
  if (input.mode === "view") return "ignore";

  if (normalizedKey === "z" && !input.shiftKey) return "undo";
  if (
    (normalizedKey === "z" && input.shiftKey) ||
    (normalizedKey === "y" && !input.shiftKey)
  ) {
    return "redo";
  }

  return "ignore";
}
