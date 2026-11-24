/** A native caret can sit on either side of a non-editable inline embed. */
export function createEmbedGap(doc: Document) {
  const gap = doc.createElement("span");
  gap.dataset.vEmbedGap = "true";
  gap.style.userSelect = "text";
  gap.style.padding = "0 0.5px";
  gap.style.outline = "none";
  gap.append(doc.createElement("v-text"));
  return gap;
}
