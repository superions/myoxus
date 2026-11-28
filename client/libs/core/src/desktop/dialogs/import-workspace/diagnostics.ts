// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { WorkspaceImportProjectionFragment } from "@myoxus/graphql";
import type { useI18n } from "@myoxus/i18n";

type Translator = ReturnType<typeof useI18n>;
type I18nKey = keyof Translator;

const DIAGNOSTIC_MESSAGE_KEYS: Record<string, I18nKey> = {
  MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED:
    "com.myoxus.workspace-import.diagnostic.label-color-normalized",
  MIX_WORKSPACE_IMPORT_FORMAT_UNSUPPORTED:
    "com.myoxus.workspace-import.diagnostic.format-unsupported",
  MIX_WORKSPACE_IMPORT_UPLOAD_LIMIT:
    "com.myoxus.workspace-import.diagnostic.upload-limit",
  MIX_WORKSPACE_IMPORT_ARCHIVE_INVALID:
    "com.myoxus.workspace-import.diagnostic.archive-invalid",
  MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT:
    "com.myoxus.workspace-import.diagnostic.archive-limit",
  MIX_WORKSPACE_IMPORT_SQLITE_INVALID:
    "com.myoxus.workspace-import.diagnostic.sqlite-invalid",
  MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED:
    "com.myoxus.workspace-import.diagnostic.sqlite-schema",
  MIX_WORKSPACE_IMPORT_SNAPSHOT_INVALID:
    "com.myoxus.workspace-import.diagnostic.snapshot-invalid",
  MIX_WORKSPACE_IMPORT_ASSET_MISSING:
    "com.myoxus.workspace-import.diagnostic.asset-missing",
  MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID:
    "com.myoxus.workspace-import.diagnostic.document-invalid",
  MIX_WORKSPACE_IMPORT_DATABASE_INVALID:
    "com.myoxus.workspace-import.diagnostic.database-invalid",
  MIX_WORKSPACE_IMPORT_DATABASE_UNSUPPORTED:
    "com.myoxus.workspace-import.diagnostic.database-unsupported",
  MIX_WORKSPACE_IMPORT_DATABASE_VALUES_OMITTED:
    "com.myoxus.workspace-import.diagnostic.database-values-omitted",
  MIX_WORKSPACE_IMPORT_VAULT_ROOT:
    "com.myoxus.workspace-import.diagnostic.vault-root",
  MIX_WORKSPACE_IMPORT_VAULT_ENTRIES_EXCLUDED:
    "com.myoxus.workspace-import.diagnostic.vault-entries-excluded",
  MIX_WORKSPACE_IMPORT_VAULT_YAML_INVALID:
    "com.myoxus.workspace-import.diagnostic.vault-yaml-invalid",
  MIX_WORKSPACE_IMPORT_VAULT_CONTENT_NORMALIZED:
    "com.myoxus.workspace-import.diagnostic.vault-content-normalized",
  MIX_WORKSPACE_IMPORT_VAULT_SOURCE_PRESERVED:
    "com.myoxus.workspace-import.diagnostic.vault-source-preserved",
  MIX_WORKSPACE_IMPORT_APPLY_BLOCKED:
    "com.myoxus.workspace-import.diagnostic.apply-blocked",
  MIX_WORKSPACE_IMPORT_PERMISSION_DENIED:
    "com.myoxus.workspace-import.diagnostic.permission-denied",
  MIX_WORKSPACE_IMPORT_CANCELLED:
    "com.myoxus.workspace-import.diagnostic.cancelled",
  MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED:
    "com.myoxus.workspace-import.diagnostic.cleanup-required",
  MIX_WORKSPACE_IMPORT_EXPIRED:
    "com.myoxus.workspace-import.diagnostic.expired",
  MIX_WORKSPACE_IMPORT_MEMBERSHIPS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.memberships-omitted",
  MIX_WORKSPACE_IMPORT_SESSIONS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.sessions-omitted",
  MIX_WORKSPACE_IMPORT_SHARING_PUBLICATIONS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.sharing-publications-omitted",
  MIX_WORKSPACE_IMPORT_COMMENTS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.comments-omitted",
  MIX_WORKSPACE_IMPORT_ACTIVITY_HISTORY_OMITTED:
    "com.myoxus.workspace-import.diagnostic.activity-history-omitted",
  MIX_WORKSPACE_IMPORT_EXTERNAL_INTEGRATIONS_CREDENTIALS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.integrations-credentials-omitted",
};

const DIAGNOSTIC_TITLE_KEYS: Record<string, I18nKey> = {
  MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED: "Tags",
  MIX_WORKSPACE_IMPORT_MEMBERSHIPS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.memberships-omitted-title",
  MIX_WORKSPACE_IMPORT_SESSIONS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.sessions-omitted-title",
  MIX_WORKSPACE_IMPORT_SHARING_PUBLICATIONS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.sharing-publications-omitted-title",
  MIX_WORKSPACE_IMPORT_COMMENTS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.comments-omitted-title",
  MIX_WORKSPACE_IMPORT_ACTIVITY_HISTORY_OMITTED:
    "com.myoxus.workspace-import.diagnostic.activity-history-omitted-title",
  MIX_WORKSPACE_IMPORT_EXTERNAL_INTEGRATIONS_CREDENTIALS_OMITTED:
    "com.myoxus.workspace-import.diagnostic.integrations-credentials-omitted-title",
};

const FORMAT_KEYS: Record<string, I18nKey> = {
  sqlite_v1: "com.myoxus.workspace-import.format.sqlite-v1",
  sqlite_doc_storage: "com.myoxus.workspace-import.format.sqlite-doc-storage",
  snapshot_zip: "com.myoxus.workspace-import.format.snapshot-zip",
  obsidian_zip: "com.myoxus.workspace-import.format.obsidian-zip",
};

const CONFIRMATION_DIAGNOSTIC_CODES = new Set([
  "MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED",
  "MIX_WORKSPACE_IMPORT_DATABASE_VALUES_OMITTED",
  "MIX_WORKSPACE_IMPORT_VAULT_CONTENT_NORMALIZED",
  "MIX_WORKSPACE_IMPORT_VAULT_SOURCE_PRESERVED",
]);

const CONFIRMATION_PRESERVATION_MODES = new Set([
  "normalized",
  "source_preserved",
]);

function callTranslator(t: Translator, key: I18nKey): string {
  const fn = t[key] as unknown as (() => string) | undefined;
  return typeof fn === "function" ? fn() : String(key);
}

export function getWorkspaceImportDiagnosticText(
  t: Translator,
  code: string,
): string {
  return callTranslator(
    t,
    DIAGNOSTIC_MESSAGE_KEYS[code] ??
      "com.myoxus.workspace-import.diagnostic.unknown",
  );
}

export function getWorkspaceImportDiagnosticTitle(
  t: Translator,
  code: string,
): string {
  const titleKey = DIAGNOSTIC_TITLE_KEYS[code];
  return titleKey
    ? callTranslator(t, titleKey)
    : getWorkspaceImportDiagnosticText(t, code);
}

export function getWorkspaceImportFormatText(
  t: Translator,
  format: string,
): string {
  return callTranslator(
    t,
    FORMAT_KEYS[format] ?? "com.myoxus.workspace-import.format.unknown",
  );
}

export function workspaceImportRequiresConfirmation(
  preview: WorkspaceImportProjectionFragment["preview"] | null | undefined,
): boolean {
  if (!preview) return false;
  if (
    preview.diagnostics.some((diagnostic) =>
      CONFIRMATION_DIAGNOSTIC_CODES.has(diagnostic.code),
    )
  ) {
    return true;
  }
  const classifications = (
    preview.targetPlan.vault as
      { classifications?: Array<{ preservation?: string }> } | null | undefined
  )?.classifications;
  return (
    classifications?.some((item) =>
      CONFIRMATION_PRESERVATION_MODES.has(item.preservation ?? ""),
    ) === true
  );
}
