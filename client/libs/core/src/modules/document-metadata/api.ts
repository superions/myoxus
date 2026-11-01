import type { GraphQLService } from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import { DebugLogger } from "@myoxus/debug";
import {
  type DocumentMetadataFieldDefinitionsQuery,
  documentMetadataFieldDefinitionsQuery,
  type DocumentMetadataQuery,
  documentMetadataQuery,
  type DocumentMetadataValidationQuery,
  documentMetadataValidationQuery,
  type DocumentMetadataValueDefinitionsQuery,
  documentMetadataValueDefinitionsQuery,
  type DocumentStatusSchemasQuery,
  documentStatusSchemasQuery,
  type DocumentStatusValuesQuery,
  documentStatusValuesQuery,
  type DocumentTypesQuery,
  documentTypesQuery,
  type GetMembersByWorkspaceIdQuery,
  getMembersByWorkspaceIdQuery,
  type SetDocumentMetadataInput,
  type SetDocumentMetadataMutation,
  setDocumentMetadataMutation,
  type TransitionDocumentStatusMutation,
  transitionDocumentStatusMutation,
  type WorkspaceDocumentSettingsQuery,
  workspaceDocumentSettingsQuery,
} from "@myoxus/graphql";

import type {
  DocumentMetadata,
  DocumentMetadataFieldDefinition,
  DocumentMetadataFieldValue,
  DocumentMetadataLookup,
  DocumentMetadataModel,
  DocumentMetadataState,
  DocumentMetadataValidation,
  SelectValueListKey,
} from "./types";

const SELECT_VALUE_LIST_KEYS = [
  "classification",
  "language",
  "audience",
  "retentionPolicy",
] as const satisfies SelectValueListKey[];

const logger = new DebugLogger("DocumentMetadata");

export interface DocumentMetadataReferenceData {
  definitions: DocumentMetadataFieldDefinition[];
  lookup: DocumentMetadataLookup;
}

export interface DocumentMetadataDocumentData {
  metadata: DocumentMetadata;
  validation: DocumentMetadataValidation;
}

export async function loadDocumentMetadataModel(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  docId: string,
  signal?: AbortSignal,
): Promise<DocumentMetadataModel> {
  const [document, references] = await Promise.all([
    loadDocumentMetadataDocumentData(
      graphqlService,
      workspaceId,
      docId,
      signal,
    ),
    loadDocumentMetadataReferenceData(graphqlService, workspaceId),
  ]);
  return buildDocumentMetadataModel(document, references);
}

export async function loadDocumentMetadataDocumentData(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  docId: string,
  signal?: AbortSignal,
): Promise<DocumentMetadataDocumentData> {
  const [metadataResponse, validationResponse] = await Promise.all([
    graphqlService.gql({
      query: documentMetadataQuery,
      variables: { workspaceId, docId },
      context: { signal },
    } as never) as Promise<DocumentMetadataQuery>,
    graphqlService.gql({
      query: documentMetadataValidationQuery,
      variables: { workspaceId, docId },
      context: { signal },
    } as never) as Promise<DocumentMetadataValidationQuery>,
  ]);

  return {
    metadata: metadataResponse.documentMetadata,
    validation: validationResponse.documentMetadataValidation,
  };
}

export async function loadDocumentMetadataReferenceData(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
): Promise<DocumentMetadataReferenceData> {
  const [
    definitionsResponse,
    typesResponse,
    settingsResponse,
    schemasResponse,
    membersResponse,
    ...valueResponses
  ] = await Promise.all([
    graphqlService.gql({
      query: documentMetadataFieldDefinitionsQuery,
    } as never) as Promise<DocumentMetadataFieldDefinitionsQuery>,
    graphqlService.gql({
      query: documentTypesQuery,
    } as never) as Promise<DocumentTypesQuery>,
    graphqlService.gql({
      query: workspaceDocumentSettingsQuery,
      variables: { workspaceId },
    } as never) as Promise<WorkspaceDocumentSettingsQuery>,
    graphqlService.gql({
      query: documentStatusSchemasQuery,
    } as never) as Promise<DocumentStatusSchemasQuery>,
    graphqlService
      .gql({
        query: getMembersByWorkspaceIdQuery,
        variables: {
          workspaceId,
          skip: 0,
          take: 100,
          query: null,
        },
      } as never)
      .catch((error: unknown) => {
        // Readers may inspect metadata without permission to enumerate members.
        // Only this permission denial makes the optional member catalog unavailable.
        const normalized = UserFriendlyError.fromAny(error);
        if (
          [normalized.code, normalized.name, normalized.type].includes(
            "ACTION_FORBIDDEN",
          )
        )
          return { workspace: null };
        throw error;
      }) as Promise<GetMembersByWorkspaceIdQuery>,
    ...SELECT_VALUE_LIST_KEYS.map((metadataKey) =>
      graphqlService.gql({
        query: documentMetadataValueDefinitionsQuery,
        variables: { fieldKey: metadataKey },
      } as never),
    ),
  ]);

  const schemaId = settingsResponse.workspaceDocumentSettings?.statusSchemaId;
  const schemaKey = schemaId
    ? schemasResponse.documentStatusSchemas.find(
        (schema) => schema.id === schemaId,
      )?.key
    : null;
  const statusValuesResponse = schemaKey
    ? ((await graphqlService.gql({
        query: documentStatusValuesQuery,
        variables: { schemaKey },
      } as never)) as DocumentStatusValuesQuery)
    : { documentStatusValues: [] };

  const valueDefinitions = SELECT_VALUE_LIST_KEYS.reduce(
    (acc, key, index) => {
      acc[key] = (
        valueResponses[index] as DocumentMetadataValueDefinitionsQuery
      ).documentMetadataValueDefinitions.filter((value) => value.isActive);
      return acc;
    },
    {} as DocumentMetadataModel["lookup"]["valueDefinitions"],
  );
  const definitions =
    definitionsResponse.documentMetadataFieldDefinitions.filter(
      (definition) => definition.enabled,
    );
  return {
    definitions,
    lookup: {
      statusValues: statusValuesResponse.documentStatusValues.filter(
        (value) => value.isActive,
      ),
      workspaceMembers: (membersResponse.workspace?.members ?? []).filter(
        (member) => member.status === "Accepted",
      ),
      documentTypes: typesResponse.documentTypes.filter(
        (type) => type.isActive,
      ),
      valueDefinitions,
    },
  };
}

export function buildDocumentMetadataModel(
  document: DocumentMetadataDocumentData,
  references: DocumentMetadataReferenceData,
): DocumentMetadataModel {
  const model: DocumentMetadataModel = {
    metadata: document.metadata,
    state: stateFromMetadata(document.metadata),
    definitions: references.definitions,
    lookup: references.lookup,
    validation: document.validation,
  };

  logger.debug("Native metadata model loaded", {
    docId: document.metadata.docId,
    workspaceId: document.metadata.workspaceId,
    projectionVersion: document.metadata.projectionVersion,
    metadataRevision: document.metadata.metadataRevision,
    definitions: references.definitions.length,
    statusValues: model.lookup.statusValues.length,
  });

  return model;
}

function metadataFieldMap(metadata: DocumentMetadata) {
  return new Map(metadata.fields.map((field) => [field.key, field]));
}

function referenceId(field: DocumentMetadataFieldValue | undefined) {
  return field?.reference?.id ?? null;
}

function referenceLabel(field: DocumentMetadataFieldValue | undefined) {
  return field?.reference?.label ?? null;
}

export function stateFromMetadata(
  metadata: DocumentMetadata,
): DocumentMetadataState {
  const fields = metadataFieldMap(metadata);
  const status = fields.get("status");
  const type = fields.get("documentType");
  const version = fields.get("version");
  const classification = fields.get("classification");
  const retentionPolicy = fields.get("retentionPolicy");
  const language = fields.get("language");
  const responsible = fields.get("responsible");
  const documentNumber = fields.get("documentNumber");
  const reviewDueAt = fields.get("reviewDueAt");
  const validFrom = fields.get("validFrom");
  const validUntil = fields.get("validUntil");

  return {
    docId: metadata.docId,
    statusId: referenceId(status),
    statusLabel: referenceLabel(status),
    typeId: referenceId(type),
    typeLabel: referenceLabel(type),
    currentVersionId: referenceId(version),
    currentVersionLabel: referenceLabel(version),
    dirtySinceCurrentVersion: version?.textValue === "dirty",
    versionDisplayMode: version?.textValue ?? "show",
    lastVersionedAt: version?.timestampValue ?? null,
    responsibleUserId: responsible?.userId ?? null,
    reviewDueAt: reviewDueAt?.timestampValue ?? null,
    validFrom: validFrom?.timestampValue ?? null,
    validUntil: validUntil?.timestampValue ?? null,
    classificationId: referenceId(classification),
    classificationLabel: referenceLabel(classification),
    documentNumber: documentNumber?.textValue ?? null,
    languageId: referenceId(language),
    languageLabel: referenceLabel(language),
    audienceIds: metadata.audience.map((entry) => entry.value.id),
    audienceLabels: metadata.audience.map((entry) => entry.value.label),
    retentionPolicyId: referenceId(retentionPolicy),
    retentionPolicyLabel: referenceLabel(retentionPolicy),
    projectionVersion: metadata.projectionVersion,
    metadataRevision: metadata.metadataRevision,
    metadataUpdatedBy: metadata.metadataUpdatedBy,
    metadataUpdatedAt: metadata.metadataUpdatedAt,
  };
}

export async function setDocumentMetadata(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  docId: string,
  input: SetDocumentMetadataInput,
  signal?: AbortSignal,
) {
  const response = (await graphqlService.gql({
    query: setDocumentMetadataMutation,
    variables: { workspaceId, docId, input },
    context: { signal },
  } as never)) as SetDocumentMetadataMutation;
  logger.info("Native metadata updated", {
    docId,
    keys: Object.keys(input),
    projectionVersion: response.setDocumentMetadata.metadata.projectionVersion,
    metadataRevision: response.setDocumentMetadata.metadata.metadataRevision,
  });
  return response.setDocumentMetadata.metadata;
}

export async function transitionDocumentStatus(
  graphqlService: Pick<GraphQLService, "gql">,
  workspaceId: string,
  docId: string,
  toStatusId: string,
  signal?: AbortSignal,
) {
  const response = (await graphqlService.gql({
    query: transitionDocumentStatusMutation,
    variables: { workspaceId, docId, input: { toStatusId } },
    context: { signal },
  } as never)) as TransitionDocumentStatusMutation;
  logger.info("Document status transitioned", {
    docId,
    toStatusId,
    valid: response.transitionDocumentStatus.validation.valid,
  });
  return response.transitionDocumentStatus.metadata;
}
