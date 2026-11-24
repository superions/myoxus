import type { SelectionRect } from "./doc-remote-selection.js";

export function selectionStyle(rect: SelectionRect, color: string) {
  return {
    position: "absolute",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    backgroundColor: rect.transparent ? "transparent" : color,
    pointerEvents: "none",
    opacity: "20%",
    borderRadius: "3px",
  };
}

export function cursorStyle(rect: SelectionRect, color: string) {
  return {
    position: "absolute",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    backgroundColor: color,
    pointerEvents: "none",
    boxShadow: "0 0 0 1px var(--myoxus-background-primary-color)",
  };
}
