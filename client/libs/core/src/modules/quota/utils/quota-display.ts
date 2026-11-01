// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatByteSize } from "@virgultum/global/utils";

const NEUTRAL_UNLIMITED_STORAGE_SENTINEL = Number.MAX_SAFE_INTEGER;
const NEUTRAL_UNLIMITED_MEMBER_SENTINEL = 2_000_000_000;

/**
 * Myoxus has no billing plans. GraphQL quota payloads may therefore expose
 * neutral "unlimited" sentinels; the UI must render them as unlimited, not as
 * 8192 PB/2147483647 style implementation values.
 */
export function isUnlimitedStorageQuota(value: number | null | undefined) {
  return (
    value !== null &&
    value !== undefined &&
    (value <= 0 || value >= NEUTRAL_UNLIMITED_STORAGE_SENTINEL)
  );
}

export function formatStorageQuotaLimit(value: number | null | undefined) {
  if (value === null || value === undefined || isUnlimitedStorageQuota(value)) {
    return null;
  }
  return formatByteSize(value);
}

export function computeStorageQuotaPercent(
  max: number | null | undefined,
  used: number | null | undefined,
) {
  if (
    max === null ||
    max === undefined ||
    used === null ||
    used === undefined ||
    isUnlimitedStorageQuota(max)
  ) {
    return null;
  }
  return Math.min(100, Math.max(0.5, Number(((used / max) * 100).toFixed(4))));
}

export function isUnlimitedMemberLimit(value: number | null | undefined) {
  return (
    value !== null &&
    value !== undefined &&
    (value <= 0 || value >= NEUTRAL_UNLIMITED_MEMBER_SENTINEL)
  );
}

export function formatMemberLimit(
  value: number | null | undefined,
  unlimitedLabel: string,
) {
  if (value === null || value === undefined || isUnlimitedMemberLimit(value)) {
    return unlimitedLabel;
  }
  return String(value);
}
