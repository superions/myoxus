export type MermaidEditableEventTarget =
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement;

export type MermaidSourceEditIntent = {
  readonly source: string;
};

export const MERMAID_INLINE_NODE_EDITOR_CLASS =
  "myoxus-mermaid-inline-node-editor";

const MERMAID_INLINE_TEXT_EDITOR_SELECTOR = [
  "edgeless-shape-text-editor",
  "edgeless-connector-label-editor",
  `.${MERMAID_INLINE_NODE_EDITOR_CLASS}`,
].join(", ");

const MERMAID_NATIVE_SHORTCUT_OWNER_SELECTOR = [
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[role="listbox"]',
  '[role="menu"]',
].join(", ");

export function createMermaidSourceEditIntent(
  source: string,
): MermaidSourceEditIntent {
  return { source };
}

function isNativeEditableControl(
  target: unknown,
): target is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

function isTextEntryInput(target: MermaidEditableEventTarget | null) {
  if (!(target instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(target.type);
}

function isRefocusableEditorTarget(target: MermaidEditableEventTarget | null) {
  return Boolean(
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    isTextEntryInput(target) ||
    (target instanceof HTMLElement &&
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLSelectElement)),
  );
}

function isInlineShapeTextEditorTarget(target: Element): target is HTMLElement {
  const shapeTextEditor = target.closest("edgeless-shape-text-editor");
  if (!shapeTextEditor || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    target.classList.contains("inline-editor") ||
    tag === "rich-text" ||
    tag === "edgeless-shape-text-editor"
  );
}

function isInlineConnectorLabelEditorTarget(
  target: Element,
): target is HTMLElement {
  const connectorLabelEditor = target.closest(
    "edgeless-connector-label-editor",
  );
  if (!connectorLabelEditor || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    target.classList.contains("inline-editor") ||
    tag === "rich-text" ||
    tag === "edgeless-connector-label-editor"
  );
}

export function hasActiveMermaidInlineTextEditor() {
  return Boolean(document.querySelector(MERMAID_INLINE_TEXT_EDITOR_SELECTOR));
}

function closestNativeEditableControl(
  target: Element,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const editable = target.closest("input, select, textarea");
  return isNativeEditableControl(editable) ? editable : null;
}

export function findMermaidEditableEventTarget(
  event: Event,
): MermaidEditableEventTarget | null {
  const path = event.composedPath();
  for (const item of path.length > 0 ? path : [event.target]) {
    if (isNativeEditableControl(item)) return item;
    if (!(item instanceof Element)) continue;

    const nativeShortcutOwner = item.closest(
      MERMAID_NATIVE_SHORTCUT_OWNER_SELECTOR,
    );
    if (nativeShortcutOwner instanceof HTMLElement) return nativeShortcutOwner;

    if (
      isInlineShapeTextEditorTarget(item) ||
      isInlineConnectorLabelEditorTarget(item)
    ) {
      return item;
    }

    const editable = closestNativeEditableControl(item);
    if (editable) return editable;
  }
  return null;
}

export function shouldRefocusMermaidEditableTarget({
  eventType,
  target,
}: {
  eventType: string;
  target: MermaidEditableEventTarget | null;
}) {
  return Boolean(
    isRefocusableEditorTarget(target) &&
    (eventType === "click" ||
      eventType === "mousedown" ||
      eventType === "mouseup" ||
      eventType === "pointerdown"),
  );
}

export function shouldPreventMermaidEditableFocusDefault({
  isCancelable,
  target,
}: {
  isCancelable: boolean;
  target: MermaidEditableEventTarget | null;
}) {
  return Boolean(
    isCancelable &&
    (isTextEntryInput(target) || target instanceof HTMLTextAreaElement),
  );
}
