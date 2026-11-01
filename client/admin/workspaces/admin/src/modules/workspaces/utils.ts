const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number) {
  const normalized = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (normalized < 1) return "0 B";

  const magnitude = Math.min(
    Math.floor(Math.log(normalized) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const scaled = normalized / 1024 ** magnitude;
  const fractionDigits = scaled < 10 ? 1 : 0;

  return `${scaled.toFixed(fractionDigits)} ${BYTE_UNITS[magnitude]}`;
}
