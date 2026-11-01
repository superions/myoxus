type MantineLengthVariable = `--mantine-${string}`;

function cssLengthToPixels(element: Element, value: string): number {
  const numericValue = Number.parseFloat(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  if (value.endsWith("rem")) {
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return numericValue * rootFontSize;
  }

  if (value.endsWith("em")) {
    const elementFontSize = Number.parseFloat(
      getComputedStyle(element).fontSize,
    );
    return numericValue * elementFontSize;
  }

  return numericValue;
}

/**
 * Resolves Mantine spacing variables for numeric browser APIs such as
 * Floating UI. Multiple variables are summed so product code does not need a
 * parallel spacing-token family or hard-coded pixel conversion.
 */
export function mantineLengthPx(
  element: Element,
  ...variables: MantineLengthVariable[]
): number {
  const computedStyle = getComputedStyle(element);
  return variables.reduce(
    (sum, variable) =>
      sum +
      cssLengthToPixels(element, computedStyle.getPropertyValue(variable)),
    0,
  );
}
