// SPDX-License-Identifier: AGPL-3.0-or-later

import { type CSSProperties, useMemo } from "react";

/** Native SVG text wrapping measured with the resolved font of the mounted editor. */
export function BpmnSvgLabel({
  text,
  font,
  width,
  transform,
  textAnchor,
  verticalAnchor,
}: {
  text: string;
  font: CSSProperties;
  width: number;
  transform: string;
  textAnchor: "start" | "middle" | "end";
  verticalAnchor: "start" | "middle" | "end";
}) {
  const lines = useMemo(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("BPMN_TEXT_MEASUREMENT_UNAVAILABLE");
    context.font = `${font.fontStyle || "normal"} ${font.fontWeight || "normal"} ${font.fontSize} ${font.fontFamily}`;
    const result: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && context.measureText(candidate).width > width) {
          result.push(line);
          line = "";
        }
        // The canvas uses normal pre-wrap, not word-break: break-all. Keep an
        // unbreakable label whole, even outside an event's small shape; the
        // committed SVG content measurement includes that external extent.
        line = line ? `${line} ${word}` : word;
      }
      result.push(line);
    }
    return result;
  }, [font, text, width]);
  const size = Number.parseFloat(String(font.fontSize));
  const lineHeight = Number.parseFloat(String(font.lineHeight));
  if (!Number.isFinite(size) || !Number.isFinite(lineHeight))
    throw new Error("BPMN_UNRESOLVED_EXPORT_FONT");
  const firstBaseline =
    verticalAnchor === "middle"
      ? size / 3 - ((lines.length - 1) * lineHeight) / 2
      : verticalAnchor === "end"
        ? -size / 3 - (lines.length - 1) * lineHeight
        : size;
  return (
    <text
      transform={transform}
      textAnchor={textAnchor}
      style={font}
      fill="var(--mantine-color-text)"
    >
      {lines.map((line, index) => (
        <tspan key={index} x={0} y={firstBaseline + index * lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}
