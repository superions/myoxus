// SPDX-License-Identifier: AGPL-3.0-or-later

type TemporalInput = Date | number | string | null | undefined;

function toDate(value: TemporalInput): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAdminDateTime(
  language: string | undefined,
  value: TemporalInput,
  fallback = "--",
): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" && value ? value : fallback;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatAdminDate(
  language: string | undefined,
  value: TemporalInput,
  fallback = "--",
): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" && value ? value : fallback;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
  }).format(date);
}

export function formatAdminCompactDate(
  language: string | undefined,
  value: TemporalInput,
  fallback = "--",
): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" && value ? value : fallback;
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatAdminTime(
  language: string | undefined,
  value: TemporalInput,
  fallback = "--",
): string {
  const date = toDate(value);
  if (!date) return typeof value === "string" && value ? value : fallback;
  return new Intl.DateTimeFormat(language, {
    timeStyle: "medium",
  }).format(date);
}

export function formatAdminInteger(
  language: string | undefined,
  value: number | null | undefined,
  fallback = "--",
): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return new Intl.NumberFormat(language, {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatAdminPercent(
  language: string | undefined,
  value: number | null | undefined,
  fallback = "--",
): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}
