// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { adminFetch } from "../fetch-utils";

function normalizeSubPath(subPath: string | undefined) {
  if (!subPath || subPath === "/") return "";
  return subPath.replace(/\/+$/, "");
}

function runtimeSubPath() {
  return normalizeSubPath(globalThis.environment?.subPath);
}

export interface HealthSnapshot {
  uptime_seconds?: number;
  checks?: Array<{
    name: string;
    status: string;
    code: string;
    detail: string;
  }>;
}

export interface GlobalTlsSnapshot {
  source: string | null;
  source_key: string | null;
  additional_ca_count: number;
  legacy_git_ca_count: number;
  snapshot_id: string;
  legacy: boolean;
}

/** Only startup observations can claim loaded trust; missing/old status is not
 * equivalent to a successfully loaded empty bundle. Never inspect a CA file in
 * the browser or substitute the current candidate configuration for this data. */
export async function fetchGlobalTlsSnapshot(): Promise<GlobalTlsSnapshot> {
  // /health belongs to the delivery gateway. /ready is the API's existing
  // process readiness projection and carries the immutable startup checks.
  const response = await adminFetch(`${runtimeSubPath()}/ready`, {
    admin: {
      channel: "health",
      operationName: "globalTlsStartup",
      invalidateOnAuthFailure: false,
    },
  });
  if (!response.ok) throw new Error("TLS startup status unavailable");
  const health = (await response.json()) as HealthSnapshot;
  const check = health?.checks?.find(
    (item) => item.name === "additional_ca_trust",
  );
  if (
    !check ||
    check.status !== "pass" ||
    !["tls_bootstrap_loaded", "tls_legacy_git_migration_required"].includes(
      check.code,
    )
  )
    throw new Error("TLS startup status unavailable");
  const detail: unknown = JSON.parse(check.detail);
  if (!detail || typeof detail !== "object")
    throw new Error("Invalid TLS startup status");
  const value = detail as Record<string, unknown>;
  if (
    typeof value.snapshot_id !== "string" ||
    !Number.isSafeInteger(value.additional_ca_count) ||
    Number(value.additional_ca_count) < 0 ||
    !Number.isSafeInteger(value.legacy_git_ca_count) ||
    Number(value.legacy_git_ca_count) < 0 ||
    !(value.source === null || typeof value.source === "string") ||
    !(value.source_key === null || typeof value.source_key === "string") ||
    value.restart_required !== true
  )
    throw new Error("Invalid TLS startup status");
  return {
    source: value.source as string | null,
    source_key: value.source_key as string | null,
    additional_ca_count: value.additional_ca_count as number,
    legacy_git_ca_count: value.legacy_git_ca_count as number,
    snapshot_id: value.snapshot_id,
    legacy: check.code === "tls_legacy_git_migration_required",
  };
}

export async function fetchBrandingThemeCss(
  subPath: string | undefined = globalThis.environment?.subPath,
): Promise<string | null> {
  const response = await adminFetch(
    `${normalizeSubPath(subPath)}/api/branding/theme.css`,
    {
      admin: {
        channel: "runtime-theme",
        operationName: "brandingThemeCss",
        invalidateOnAuthFailure: false,
      },
    },
  );
  if (!response.ok) return null;
  return response.text();
}

export async function fetchSystemHealth(): Promise<HealthSnapshot | null> {
  const response = await adminFetch(`${runtimeSubPath()}/health`, {
    admin: {
      channel: "health",
      operationName: "systemHealth",
      invalidateOnAuthFailure: false,
    },
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload && typeof payload === "object"
    ? (payload as HealthSnapshot)
    : null;
}
