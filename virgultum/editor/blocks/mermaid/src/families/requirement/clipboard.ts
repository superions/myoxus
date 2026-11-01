// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyRequirementSelection } from "../../engine/requirement/index.js";
import type { RequirementReactHostProps } from "./react-host-contract.js";

export const REQUIREMENT_SELECTION_MIME =
  "myoxus/mermaid-requirement-selection";
export function copyRequirementCards(props: RequirementReactHostProps) {
  if (props.displayOnly || !props.clipboard) return null;
  const source = copyRequirementSelection(props.model, props.selectedKeys);
  if (!source) return null;
  return props.clipboard.write({
    "text/plain": source,
    [REQUIREMENT_SELECTION_MIME]: JSON.stringify({
      source,
      geometry: props.copyGeometry,
    }),
  });
}
export function pasteRequirementCards(
  props: RequirementReactHostProps,
  data: Record<string, unknown>,
) {
  if (props.readonly || props.displayOnly) return false;
  const encoded = data[REQUIREMENT_SELECTION_MIME];
  if (typeof encoded !== "string") return false;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return false;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("geometry" in value) ||
    !Array.isArray(value.geometry)
  )
    return false;
  const geometry = value.geometry;
  if (
    !geometry.every(
      (item) =>
        item &&
        [item.x, item.y, item.width, item.height].every(Number.isFinite) &&
        item.width > 0 &&
        item.height > 0,
    )
  )
    return false;
  return props.onPaste(value.source, props.sourceBasis, geometry).changed;
}
/** Std owns scope and input exclusion. Typed failed pastes never fall through
 * to rich text or a different owner; Cut cannot bypass Delete's impact draft. */
export function bindRequirementClipboard(
  getProps: () => RequirementReactHostProps,
) {
  const port = getProps().clipboard;
  return port?.subscribe({
    copy: (event) => {
      const write = copyRequirementCards(getProps());
      if (!write) return false;
      event.preventDefault();
      void write.catch(console.error);
      return true;
    },
    paste: (event) => {
      const data = port.read(event);
      if (typeof data[REQUIREMENT_SELECTION_MIME] !== "string") return false;
      event.preventDefault();
      pasteRequirementCards(getProps(), data);
      return true;
    },
    cut: (event) => {
      if (!getProps().selectedKeys.length) return false;
      event.preventDefault();
      return true;
    },
  });
}
