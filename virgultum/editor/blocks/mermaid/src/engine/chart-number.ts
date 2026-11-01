export function mermaidChartDecimal(value: number) {
  if (!Number.isFinite(value)) {
    throw new Error("Mermaid chart values must be finite numbers.");
  }
  const source = String(value);
  const exponentMarker = source.search(/[eE]/);
  if (exponentMarker < 0) return source;

  const coefficient = source.slice(0, exponentMarker);
  const exponent = Number(source.slice(exponentMarker + 1));
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  const sign = negative ? "-" : "";
  if (decimalIndex <= 0) {
    return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}
