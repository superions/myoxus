import type {
  DocumentMetadataFieldDefinitionsQuery,
  DocumentMetadataQuery,
  DocumentMetadataValidationQuery,
  DocumentMetadataValueDefinitionsQuery,
  DocumentStatusSchemasQuery,
  DocumentStatusValuesQuery,
  DocumentTypesQuery,
  GetMembersByWorkspaceIdQuery,
  SetDocumentMetadataInput,
} from "@myoxus/graphql";

export type DocumentMetadata = DocumentMetadataQuery["documentMetadata"];
export type DocumentMetadataValidation =
  DocumentMetadataValidationQuery["documentMetadataValidation"];
export type DocumentMetadataFieldValue = DocumentMetadata["fields"][number];
export type DocumentMetadataAudience = DocumentMetadata["audience"][number];
export type DocumentMetadataFieldDefinition =
  DocumentMetadataFieldDefinitionsQuery["documentMetadataFieldDefinitions"][number];
export type DocumentStatusValue =
  DocumentStatusValuesQuery["documentStatusValues"][number];
export type DocumentStatusSchema =
  DocumentStatusSchemasQuery["documentStatusSchemas"][number];
export type DocumentTypeDefinition =
  DocumentTypesQuery["documentTypes"][number];
export type DocumentMetadataValueDefinition =
  DocumentMetadataValueDefinitionsQuery["documentMetadataValueDefinitions"][number];
export type WorkspaceMember = NonNullable<
  GetMembersByWorkspaceIdQuery["workspace"]
>["members"][number];
export type MetadataPatch = SetDocumentMetadataInput;

export type CanonicalMetadataKey =
  | "status"
  | "documentType"
  | "version"
  | "responsible"
  | "reviewDueAt"
  | "validFrom"
  | "validUntil"
  | "classification"
  | "documentNumber"
  | "language"
  | "audience"
  | "retentionPolicy";

export type SelectValueListKey =
  "classification" | "language" | "audience" | "retentionPolicy";

export interface DocumentMetadataLookup {
  statusValues: DocumentStatusValue[];
  documentTypes: DocumentTypeDefinition[];
  workspaceMembers: WorkspaceMember[];
  valueDefinitions: Record<
    SelectValueListKey,
    DocumentMetadataValueDefinition[]
  >;
}

export interface DocumentMetadataState {
  docId: string;
  statusId: string | null;
  statusLabel: string | null;
  typeId: string | null;
  typeLabel: string | null;
  currentVersionId: string | null;
  currentVersionLabel: string | null;
  dirtySinceCurrentVersion: boolean;
  versionDisplayMode: string;
  lastVersionedAt: string | null;
  responsibleUserId: string | null;
  reviewDueAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  classificationId: string | null;
  classificationLabel: string | null;
  documentNumber: string | null;
  languageId: string | null;
  languageLabel: string | null;
  audienceIds: string[];
  audienceLabels: string[];
  retentionPolicyId: string | null;
  retentionPolicyLabel: string | null;
  projectionVersion: string;
  metadataRevision: number;
  metadataUpdatedBy: string | null;
  metadataUpdatedAt: string | null;
}

export interface DocumentMetadataModel {
  metadata: DocumentMetadata;
  state: DocumentMetadataState;
  definitions: DocumentMetadataFieldDefinition[];
  lookup: DocumentMetadataLookup;
  validation: DocumentMetadataValidation;
}
