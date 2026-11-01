const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
const BINARY_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Binary storage labels keep the established compact, two-decimal contract.
 * Non-finite values have no display label; this function does not parse strings. */
export function formatByteSize(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const magnitude = Math.abs(value);
  let exponent = BINARY_UNITS.length - 1;
  while (exponent > 0 && magnitude < 1024 ** exponent) exponent--;
  const rounded = (value / 1024 ** exponent).toFixed(2);
  return `${rounded.replace(/(?:\.0*|(\.[^0]+)0+)$/, "$1")}${BINARY_UNITS[exponent]}`;
}

/** Decimal attachment labels use SI units, spaces and the existing rounding.
 * NaN is an invalid size; infinite values retain their diagnostic YB label. */
export function formatDecimalByteSize(value: number): string {
  if (Number.isNaN(value)) throw new TypeError("Invalid file size");
  if (!Number.isFinite(value)) return `${value} YB`;
  const exponent = Math.max(
    0,
    Math.min(
      Math.floor(Math.log10(Math.abs(value)) / 3),
      DECIMAL_UNITS.length - 1,
    ),
  );
  const scaled = value / 1000 ** exponent;
  const rounded = Math.round((scaled + Number.EPSILON) * 100) / 100;
  return `${rounded} ${DECIMAL_UNITS[exponent]}`;
}
