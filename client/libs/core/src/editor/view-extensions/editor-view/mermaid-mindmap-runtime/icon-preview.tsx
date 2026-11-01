// SPDX-License-Identifier: AGPL-3.0-or-later
import { mindmapIconResource } from "@virgultum/block-mermaid";

/** Passive geometry from the same bundled resource painted by native GFX. */
export function MindmapIconPreview({ name }: { name: string }) {
  const icon = mindmapIconResource(name);
  if (!icon) return null;
  return (
    <svg
      width="1.5em"
      height="1.5em"
      viewBox={icon.viewBox.join(" ")}
      fill="none"
      stroke="currentColor"
      strokeWidth={icon.strokeWidth}
      aria-hidden="true"
      focusable="false"
    >
      {icon.paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
