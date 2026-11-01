// Native Kanban exposes card/group names as ARIA labels for Mermaid/Data-View
// browser evidence. Data-View cell values can be rich objects, so never let the
// default object string leak into the accessible name.
export function kanbanAccessibleText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const text = value.toString().trim();
    return text === "[object Object]" ? "" : text;
  }
  return "";
}
