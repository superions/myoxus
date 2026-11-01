import { DocumentMetadataProjectionModeType } from "@myoxus/graphql";

import type { PdfExportDialogBootstrap } from "../types";

export function createPdfExportBootstrap(): PdfExportDialogBootstrap {
  return {
    availablePdfTemplates: [
      {
        id: "tpl-default",
        slug: "default",
        name: "Default",
        version: "1.0.0",
        schemaVersion: "2.0",
        isDefault: true,
        capabilities: {
          language: { kind: "enum", values: ["en", "de"], default: "en" },
          tocBehavior: {
            kind: "enum",
            values: ["auto", "always", "never"],
            default: "auto",
          },
        },
      },
      {
        id: "tpl-report",
        slug: "report",
        name: "Report",
        version: "1.0.0",
        schemaVersion: "2.0",
        isDefault: false,
        capabilities: {
          language: { kind: "enum", values: ["en", "de"], default: "en" },
          tocBehavior: {
            kind: "enum",
            values: ["auto", "always", "never"],
            default: "auto",
          },
        },
      },
    ],
    pdfExportSettings: {
      workspaceId: "ws-1",
      defaultTemplateId: "tpl-default",
      defaultLocale: "en",
      defaultPaperSize: "A4",
      defaultColorProfile: null,
      defaultImageQuality: "high",
      ligaturesEnabled: true,
    },
    documentBrandingProfile: {
      workspaceId: "ws-1",
      logoLargeBlob: null,
      logoSmallBlob: null,
      footerText: null,
      brandColorPrimary: null,
      brandColorAccent: null,
    },
    documentVersioningSettings: {
      docId: "doc-1",
      enabled: false,
      retentionCount: 10,
      autoVersionOn: [],
    },
    documentVersions: [],
    documentMetadataValidation: {
      valid: true,
      missingRequiredMetadataFields: [],
      blockedActions: [],
      errors: [],
      warnings: [],
    },
    documentMetadata: {
      docId: "doc-1",
      workspaceId: "ws-1",
      projectionMode: DocumentMetadataProjectionModeType.MYOXUS_NATIVE,
      projectionVersion: "1",
      metadataRevision: 1,
      metadataUpdatedAt: null,
      metadataUpdatedBy: null,
      system: {
        createdAt: "2026-05-01T12:00:00.000Z",
        updatedAt: "2026-05-01T12:00:00.000Z",
        createdBy: "user-1",
        updatedBy: null,
        metadataUpdatedAt: null,
        metadataUpdatedBy: null,
      },
      fields: [],
      audience: [],
      template: null,
      journal: { journalDate: null },
      presentation: null,
      integration: null,
      policy: { locks: [] },
      legacy: null,
    },
  };
}
