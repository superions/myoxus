/**
 * @vitest-environment node
 *
 * WorkspaceQuota formatting invariants — P112-QUOTA-VERIFY-C-01
 *
 * Guards the client-side quota display logic against regressions:
 *  1. storageQuota bytes → formatted string (P112 server fix returns real values now)
 *  2. storageQuota = 0 (server's unlimited sentinel) → null max/percent
 *  3. quota object = null → null (not yet loaded / no quota)
 *
 * These tests exercise the mapping logic in WorkspaceQuota and UserQuota entities
 * without instantiating the full DI tree (avoids @myoxus/theme OOM in vitest).
 *
 * Reference: WorkspaceQuota.max$ / maxFormatted$ in
 *   client/libs/core/src/modules/quota/entities/quota.ts
 */
import { describe, expect, test } from "vitest";

import {
  computeStorageQuotaPercent,
  formatMemberLimit,
  formatStorageQuotaLimit,
  isUnlimitedMemberLimit,
  isUnlimitedStorageQuota,
} from "../utils/quota-display";

type WorkspaceQuotaLike = { storageQuota: number } | null;

/**
 * Mirrors WorkspaceQuota.max$:
 *   quota$ → quota ? quota.storageQuota : null
 */
function extractMax(quota: WorkspaceQuotaLike): number | null {
  return quota ? quota.storageQuota : null;
}

// ---------------------------------------------------------------------------
// INV-QUOTA-FORMAT-01 — P112 fix: workspace 50 MB override
// ---------------------------------------------------------------------------

describe("WorkspaceQuota — P112 fix: real quota values from server", () => {
  test("inv_quota_format_50mb — storageQuota=52428800 has MB magnitude", () => {
    const quota: WorkspaceQuotaLike = { storageQuota: 52428800 };
    const max = extractMax(quota);
    expect(max).toBe(52428800);
    const fmt = formatStorageQuotaLimit(max);
    // bytes.format output: "50 MB" or "50MB" depending on package version
    expect(fmt).not.toBeNull();
    expect(fmt).toMatch(/^50\s*MB$/);
  });

  test("inv_quota_format_2gb — storageQuota=2147483648 has GB magnitude", () => {
    const quota: WorkspaceQuotaLike = { storageQuota: 2147483648 };
    const max = extractMax(quota);
    expect(max).toBe(2147483648);
    const fmt = formatStorageQuotaLimit(max);
    expect(fmt).not.toBeNull();
    expect(fmt).toMatch(/^2\s*GB$/);
  });

  test("inv_quota_format_1gb — storageQuota=1073741824 has GB magnitude", () => {
    const quota: WorkspaceQuotaLike = { storageQuota: 1073741824 };
    const fmt = formatStorageQuotaLimit(extractMax(quota));
    expect(fmt).not.toBeNull();
    expect(fmt).toMatch(/^1\s*GB$/);
  });
});

// ---------------------------------------------------------------------------
// INV-QUOTA-UNLIMITED — server returns 0 for unlimited workspaces
// ---------------------------------------------------------------------------

describe("WorkspaceQuota — unlimited workspace (storageQuota = 0)", () => {
  test("inv_quota_unlimited_zero — storageQuota=0 → max is 0 → maxFormatted is null", () => {
    // Server returns storageQuota=0 for workspaces with unlimited quota
    // (personal workspaces without team override)
    const quota: WorkspaceQuotaLike = { storageQuota: 0 };
    const max = extractMax(quota); // quota is truthy, so max = 0
    expect(max).toBe(0);
    const fmt = formatStorageQuotaLimit(max);
    expect(fmt).toBeNull();
  });

  test("inv_quota_unlimited_i64_sentinel — neutral max int storage quota stays unlimited", () => {
    const max = 9_223_372_036_854_776_000;
    expect(isUnlimitedStorageQuota(max)).toBe(true);
    expect(formatStorageQuotaLimit(max)).toBeNull();
    expect(computeStorageQuotaPercent(max, 1234)).toBeNull();
  });

  test("inv_quota_null_object — quota=null → max is null → maxFormatted is null", () => {
    const max = extractMax(null);
    expect(max).toBeNull();
    const fmt = formatStorageQuotaLimit(max);
    expect(fmt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INV-QUOTA-PERCENT — division guard for unlimited (percent$ safety)
// ---------------------------------------------------------------------------

describe("WorkspaceQuota — percent calculation edge cases", () => {
  /**
   * Mirrors WorkspaceQuota.percent$ computation.
   * When max = 0, the workspace is unlimited and no percent is rendered.
   * When max = null, percent = null (loading state).
   */
  test("inv_quota_percent_null_when_max_null — no max → loading state", () => {
    expect(computeStorageQuotaPercent(null, 1000)).toBeNull();
    expect(computeStorageQuotaPercent(null, null)).toBeNull();
  });

  test("inv_quota_percent_null_when_max_zero — unlimited quota has no progress cap", () => {
    expect(computeStorageQuotaPercent(0, 1000)).toBeNull();
  });

  test("inv_quota_percent_null_when_used_null — no usage data → loading state", () => {
    expect(computeStorageQuotaPercent(1073741824, null)).toBeNull();
  });

  test("inv_quota_percent_nonzero_for_small_usage — min 0.5% for non-empty", () => {
    // 1 byte used out of 2 GB → rounds to 0.5% minimum
    const pct = computeStorageQuotaPercent(2147483648, 1);
    expect(pct).toBe(0.5);
  });

  test("inv_quota_percent_capped_at_100 — cannot exceed 100%", () => {
    // over-quota: used > max
    const pct = computeStorageQuotaPercent(1048576, 10485760); // used 10× the limit
    expect(pct).toBe(100);
  });
});

describe("WorkspaceQuota — member limit sentinels", () => {
  test("inv_member_limit_int_max — neutral max int member limit renders as unlimited", () => {
    expect(isUnlimitedMemberLimit(2_147_483_647)).toBe(true);
    expect(formatMemberLimit(2_147_483_647, "Unbegrenzt")).toBe("Unbegrenzt");
  });

  test("inv_member_limit_real_value — finite member limits stay visible", () => {
    expect(isUnlimitedMemberLimit(50)).toBe(false);
    expect(formatMemberLimit(50, "Unbegrenzt")).toBe("50");
  });
});
