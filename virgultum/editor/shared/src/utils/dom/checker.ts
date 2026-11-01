import type { EditorHost } from "@virgultum/std";

export function isInsidePageEditor(host?: EditorHost) {
  if (!host) return false;
  return Array.from(host.children).some(
    (v) => v.tagName.toLowerCase() === "myoxus-page-root",
  );
}

export function isInsideEdgelessEditor(host?: EditorHost) {
  if (!host) return false;

  return Array.from(host.children).some(
    (v) =>
      v.tagName.toLowerCase() === "myoxus-edgeless-root" ||
      v.tagName.toLowerCase() === "myoxus-edgeless-root-preview",
  );
}
