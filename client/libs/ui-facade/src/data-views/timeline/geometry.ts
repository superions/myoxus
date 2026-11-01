// SPDX-License-Identifier: AGPL-3.0-or-later

/** Technical card/axis geometry. Density never alters typography or product zoom. */
export function ordinalTimelineGeometry(
  width: number,
  labels: readonly string[],
  font: string,
  density = 40,
  fitCount = 0,
  chromeWidth = 32,
) {
  const canvas =
    typeof document === "undefined" ? null : document.createElement("canvas");
  const context = canvas?.getContext("2d");
  if (context) context.font = font;
  const measured = labels.map(
    (label) => context?.measureText(label).width ?? 0,
  );
  // Readable line lengths bound card wrapping; CSS intrinsic rows own the measured heights.
  const cardWidth = Math.max(
    220,
    Math.min(320, Math.max(0, ...measured) + chromeWidth),
  );
  const fittedGap =
    fitCount > 1 ? (width - fitCount * cardWidth) / (fitCount - 1) : density;
  return {
    cardWidth,
    viewportWidth: Math.max(0, width),
    anchorGap: Math.max(density, fittedGap),
  };
}
