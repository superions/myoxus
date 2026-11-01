// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DebugLogger } from "@myoxus/debug";

import { getAdminRequestDiagnostic } from "../../fetch-utils";

const logger = new DebugLogger("AdminGitSync");
const SAFE_TOKEN = /[^a-zA-Z0-9_.:/-]/g;
const SAFE_FIELD_PATH = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const reportedDiagnoses = new Set<string>();

export type GitSyncDiagnosis = {
  id: string;
  code: string;
  tab: string;
  operationName?: string;
  fieldPath?: string;
  expectedType?: string;
  actualType?: string;
  schemaRevision?: string;
  configRevision?: string;
  componentStack?: string;
};

function safeToken(value: string | undefined, fallback = "unknown") {
  return (value ?? fallback).replace(SAFE_TOKEN, "_").slice(0, 160);
}

function safeFieldPath(value: string) {
  return SAFE_FIELD_PATH.test(value)
    ? value.slice(0, 160)
    : "invalid_config_path";
}

function componentNames(stack: string | undefined) {
  if (!stack) return undefined;
  const names = [...stack.matchAll(/\bat\s+([A-Za-z0-9_$]+)/g)]
    .map((match) => match[1])
    .slice(0, 12);
  return names.length ? names.join(">") : undefined;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createGitSyncDiagnosis(
  diagnosis: Omit<GitSyncDiagnosis, "id">,
): GitSyncDiagnosis {
  const code = safeToken(diagnosis.code);
  const tab = safeToken(diagnosis.tab);
  const fieldPath = diagnosis.fieldPath
    ? safeFieldPath(diagnosis.fieldPath)
    : undefined;
  const id = `GITSYNC-${code}-${stableHash(`${tab}:${fieldPath ?? ""}`)}`;
  return {
    ...diagnosis,
    id,
    code,
    tab,
    fieldPath,
    expectedType: diagnosis.expectedType
      ? safeToken(diagnosis.expectedType)
      : undefined,
    actualType: diagnosis.actualType
      ? safeToken(diagnosis.actualType)
      : undefined,
    schemaRevision: diagnosis.schemaRevision?.slice(0, 16),
    configRevision: diagnosis.configRevision?.slice(0, 16),
    componentStack: componentNames(diagnosis.componentStack),
  };
}

/**
 * Sends only bounded structural metadata through the existing Admin debug
 * channel. Raw config values, GraphQL payloads, exception text and file paths
 * are deliberately excluded.
 */
export function reportGitSyncDiagnosis(diagnosis: GitSyncDiagnosis) {
  const request = diagnosis.operationName
    ? getAdminRequestDiagnostic(diagnosis.operationName)
    : undefined;
  const reportKey = [
    diagnosis.id,
    diagnosis.schemaRevision ?? "",
    diagnosis.configRevision ?? "",
    request?.correlationId ?? "",
  ].join(":");
  if (reportedDiagnoses.has(reportKey)) return;
  reportedDiagnoses.add(reportKey);
  logger.warn("git sync admin diagnosis", {
    diagnosisId: diagnosis.id,
    code: diagnosis.code,
    route: "/adminfrontend/git-sync",
    tab: diagnosis.tab,
    operationName: diagnosis.operationName,
    correlationId: request?.correlationId ?? null,
    frontendVersion:
      request?.frontendVersion ??
      (
        globalThis as typeof globalThis & {
          BUILD_CONFIG?: { appVersion?: string };
        }
      ).BUILD_CONFIG?.appVersion ??
      "unknown",
    fieldPath: diagnosis.fieldPath,
    expectedType: diagnosis.expectedType,
    actualType: diagnosis.actualType,
    schemaRevision: diagnosis.schemaRevision,
    configRevision: diagnosis.configRevision,
    componentStack: diagnosis.componentStack,
  });
}
