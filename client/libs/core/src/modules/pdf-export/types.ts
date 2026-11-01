import {
  type DocumentMetadataFieldsFragment,
  type DocumentMetadataValidationFieldsFragment,
  type GraphQLQuery,
} from "@myoxus/graphql";

export const workspacePdfExportSettingsQuery = {
  id: "workspacePdfExportSettings",
  op: "workspacePdfExportSettings",
  query: `query workspacePdfExportSettings($workspaceId: ID!) {
    availablePdfTemplates(workspaceId: $workspaceId) {
      id
      slug
      name
      version
      schemaVersion
      isDefault
      capabilities
      inputsSchema
    }
    pdfExportSettings(workspaceId: $workspaceId) {
      workspaceId
      defaultTemplateId
      defaultLocale
      defaultPaperSize
      defaultColorProfile
      defaultImageQuality
      ligaturesEnabled
    }
    documentBrandingProfile(workspaceId: $workspaceId) {
      workspaceId
      logoLargeBlob
      logoSmallBlob
      footerText
      brandColorPrimary
      brandColorAccent
    }
  }`,
} satisfies GraphQLQuery;

export const documentPdfExportHistoryQuery = {
  id: "documentPdfExportHistory",
  op: "documentPdfExportHistory",
  query: `query documentPdfExportHistory($workspaceId: String!, $docId: String!, $limit: Int) {
    documentPdfExportHistory(workspaceId: $workspaceId, docId: $docId, limit: $limit) {
      id
      workspaceId
      docId
      templateId
      status
      downloadUrl
      errorClass
      errorDetail
      renderInputs
      pageCount
      createdAt
      startedAt
      finishedAt
      expiresAt
      unmappedFontFamilies
    }
}`,
} satisfies GraphQLQuery;

export type PdfTemplateCapability = {
  kind?: string;
  values?: string[];
  default?: unknown;
  min_items?: number;
  max_items?: number;
};

export type PdfTemplateCapabilities = Record<string, PdfTemplateCapability>;

export interface PdfTemplateInputsSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  pattern?: string;
  format?: string;
  items?: PdfTemplateInputsSchemaProperty;
}

export interface PdfTemplateInputsSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, PdfTemplateInputsSchemaProperty>;
}

export interface PdfTemplateOption {
  id: string;
  slug: string;
  name: string;
  version: string;
  schemaVersion: string;
  capabilities: PdfTemplateCapabilities;
  inputsSchema?: PdfTemplateInputsSchema | null;
  isDefault: boolean;
}

export interface PdfExportSettings {
  workspaceId: string;
  defaultTemplateId: string | null;
  defaultLocale: string | null;
  defaultPaperSize: string | null;
  defaultColorProfile: string | null;
  defaultImageQuality: string | null;
  ligaturesEnabled: boolean;
}

export interface DocumentBrandingProfile {
  workspaceId: string;
  logoLargeBlob: string | null;
  logoSmallBlob: string | null;
  footerText: string | null;
  brandColorPrimary: string | null;
  brandColorAccent: string | null;
}

export interface PdfExportDialogBootstrap {
  availablePdfTemplates: PdfTemplateOption[];
  pdfExportSettings: PdfExportSettings;
  documentBrandingProfile: DocumentBrandingProfile;
  documentVersioningSettings: PdfDocumentVersioningSettings;
  documentVersions: PdfDocumentVersionOption[];
  documentMetadataValidation: DocumentMetadataValidationFieldsFragment;
  documentMetadata: DocumentMetadataFieldsFragment;
}

export type WorkspacePdfExportSettingsBootstrap = Pick<
  PdfExportDialogBootstrap,
  "availablePdfTemplates" | "pdfExportSettings" | "documentBrandingProfile"
>;

export interface PdfDocumentVersioningSettings {
  docId: string;
  enabled: boolean;
  retentionCount: number;
  autoVersionOn: string[];
}

export interface PdfDocumentVersionOption {
  id: string;
  label: string;
  description: string | null;
  createdAt: string;
  isPinned: boolean;
}

export interface PdfExportDialogFormValue {
  locale?: string;
  paperSize?: string;
  orientation?: string;
  imageQuality?: string;
  /** New dialogs select pdfa-2u; standard explicitly selects Tagged PDF 1.7. */
  complianceProfile?: string;
  coverPage?: boolean;
  tocBehavior?: string;
  footerStyle?: string;
  pageNumbering?: string;
  colorVariant?: string;

  confidentialityLabel?: string;
  typedInputs?: unknown;
}

export interface PdfExportHistoryEntry {
  id: string;
  workspaceId: string;
  docId: string;
  templateId: string;
  status: "queued" | "running" | "done" | "failed" | string;
  downloadUrl: string | null;
  errorClass: string | null;
  errorDetail: string | null;
  renderInputs: Record<string, unknown>;
  pageCount: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  unmappedFontFamilies: string[];
}

export interface PdfExportHistoryResponse {
  documentPdfExportHistory: PdfExportHistoryEntry[];
}
