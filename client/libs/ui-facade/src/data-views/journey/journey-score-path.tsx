// SPDX-License-Identifier: AGPL-3.0-or-later
import { cssVar } from "@myoxus/theme";
import type { JourneyMapSection, JourneyMapLabels } from "./types";
/** Fixed score coordinates are renderer geometry. Native Mantine owns every label/control around this plane. */
export function JourneyScorePath({
  sections,
  stepWidth,
  labels,
  preview,
  previewLabel,
}: {
  sections: readonly JourneyMapSection[];
  stepWidth: number;
  labels: JourneyMapLabels;
  preview?: readonly JourneyMapSection[];
  previewLabel?: string;
}) {
  const plot = (sections: readonly JourneyMapSection[]) => {
    let slot = 0;
    let path = "";
    let connected = false;
    for (const section of sections) {
      if (!section.steps.length) {
        slot++;
        continue;
      }
      for (const step of section.steps) {
        const x = (slot++ + 0.5) * stepWidth;
        if (!Number.isFinite(step.score)) {
          connected = false;
          continue;
        }
        const y = 24 + (5 - Math.max(1, Math.min(5, step.score))) * 48;
        path += `${connected ? "L" : "M"}${x},${y} `;
        connected = true;
      }
    }
    return { path, width: Math.max(1, slot) * stepWidth };
  };
  const { path, width } = plot(sections);
  const ghost = preview ? plot(preview) : undefined;
  return (
    <svg
      className="myoxus-journey-score-path"
      width={width}
      height={240}
      viewBox={`0 0 ${width} 240`}
      aria-label={labels.scoreAxis}
      role="img"
    >
      {[5, 4, 3, 2, 1].map((v, i) => (
        <line
          key={v}
          x1={0}
          x2={width}
          y1={24 + i * 48}
          y2={24 + i * 48}
          stroke={cssVar("borderColor")}
        />
      ))}
      {ghost ? (
        <path
          d={ghost.path}
          fill="none"
          stroke={cssVar("primaryColor")}
          strokeWidth={3}
          strokeDasharray="6 4"
          aria-label={previewLabel}
        />
      ) : null}
      <path
        d={path}
        fill="none"
        stroke={cssVar("primaryColor")}
        strokeWidth={3}
      />
    </svg>
  );
}
