export const cleanSelection = () => {
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
  }
};

// Fractional-index keys are protocol strings, not localized text. A binary
// comparison plus stable ID tie-break keeps editor and adapter order identical
// in every browser locale.
export const compareTableOrder = (
  leftOrder: string,
  leftId: string,
  rightOrder: string,
  rightId: string,
) =>
  leftOrder < rightOrder
    ? -1
    : leftOrder > rightOrder
      ? 1
      : leftId < rightId
        ? -1
        : leftId > rightId
          ? 1
          : 0;
