import type { BaseTextAttributes } from "../../../store/index";

import type { AttributeRenderer } from "../types.js";

/** Keep the actual text/interactive child mounted when an attribute changes. */
export function inlineChild<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  const existing = parent.firstElementChild;
  const child =
    existing?.localName === tag
      ? (existing as HTMLElementTagNameMap[K])
      : parent.ownerDocument.createElement(tag);
  if (props) Object.assign(child, props);
  if (child !== existing) parent.replaceChildren(child);
  return child;
}

export function setInlineStyles(
  element: HTMLElement,
  values: Record<string, string | number | null | undefined>,
) {
  const style = element.style;
  for (const key of Array.from(style)) {
    if (values[key] == null) style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value != null && style.getPropertyValue(key) !== String(value))
      style.setProperty(key, String(value));
  }
}

function inlineTextStyles(props: BaseTextAttributes) {
  let textDecorations = "";
  if (props.underline) {
    textDecorations += "underline";
  }
  if (props.strike) {
    textDecorations += " line-through";
  }

  let inlineCodeStyle = {};
  if (props.code) {
    inlineCodeStyle = {
      "font-family":
        '"SFMono-Regular", Menlo, Consolas, "PT Mono", "Liberation Mono", Courier, monospace',
      "line-height": "normal",
      background: "rgba(135,131,120,0.15)",
      color: "#EB5757",
      "border-radius": "3px",
      "font-size": "85%",
      padding: "0.2em 0.4em",
    };
  }

  return {
    "font-weight": props.bold ? "bold" : "inherit",
    "font-style": props.italic ? "italic" : "inherit",
    "text-decoration": textDecorations.length > 0 ? textDecorations : "inherit",
    ...inlineCodeStyle,
  };
}

export const getDefaultAttributeRenderer =
  <T extends BaseTextAttributes>(): AttributeRenderer<T> =>
  ({ delta }, parent) => {
    const span = inlineChild(parent, "span");
    setInlineStyles(
      span,
      delta.attributes ? inlineTextStyles(delta.attributes) : {},
    );
    inlineChild(span, "v-text", { str: delta.insert });
    return span;
  };
