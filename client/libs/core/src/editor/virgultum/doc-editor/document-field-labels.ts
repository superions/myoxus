// SPDX-License-Identifier: AGPL-3.0-or-later
import type { useI18n } from "@myoxus/i18n";

/** Shared names for the authoritative metadata descriptors and their occurrences. */
export function documentFieldLabels(t: ReturnType<typeof useI18n>) {
  return {
    title: t["Title"](),
    versionLabel: t["com.myoxus.document-metadata.field.version"](),
    versionNumber: t["com.myoxus.editor.field.version-number"](),
    documentType: t["com.myoxus.document-metadata.field.document-type"](),
    status: t["com.myoxus.document-metadata.field.status"](),
    classification: t["com.myoxus.document-metadata.field.classification"](),
    documentNumber: t["com.myoxus.document-metadata.field.document-number"](),
    responsible: t["com.myoxus.document-metadata.field.responsible"](),
    createdBy: t["com.myoxus.document-metadata.field.created-by"](),
    updatedBy: t["com.myoxus.document-metadata.field.updated-by"](),
    createdAt: t["com.myoxus.document-metadata.field.created-at"](),
    updatedAt: t["com.myoxus.document-metadata.field.updated-at"](),
    reviewDueAt: t["com.myoxus.document-metadata.field.review-due-at"](),
    validFrom: t["com.myoxus.document-metadata.field.valid-from"](),
    validUntil: t["com.myoxus.document-metadata.field.valid-until"](),
    language: t["com.myoxus.document-metadata.field.language"](),
    audience: t["com.myoxus.document-metadata.field.audience"](),
    retentionPolicy: t["com.myoxus.document-metadata.field.retention-policy"](),
  };
}
