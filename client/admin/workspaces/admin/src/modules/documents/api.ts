/**
 * Data-access layer for the admin Documents module.
 *
 * The module intentionally imports generated GraphQL documents and response
 * types from `@myoxus/graphql`. Keeping all GraphQL plumbing here prevents tab
 * components from inventing local DTOs and makes schema drift fail at compile
 * time instead of at runtime.
 */
import {
  type AdminDocumentAuditFilterInput,
  adminDocumentAuditLogQuery,
  adminDocumentMetadataFieldDefinitionsQuery,
  adminDocumentMetadataValueDefinitionsQuery,
  adminDocumentRuntimeOverviewQuery,
  adminDocumentStatusSchemasQuery,
  adminDocumentStatusValuesQuery,
  adminDocumentTypesQuery,
  adminDocumentVersionPoliciesQuery,
  type AdminUpdateDocumentMetadataFieldDefinitionInput,
  adminUpdateDocumentMetadataFieldDefinitionMutation,
  type AdminUpsertDocumentMetadataValueDefinitionInput,
  adminUpsertDocumentMetadataValueDefinitionMutation,
  type AdminUpsertDocumentStatusSchemaInput,
  adminUpsertDocumentStatusSchemaMutation,
  type AdminUpsertDocumentStatusTransitionInput,
  adminUpsertDocumentStatusTransitionMutation,
  type AdminUpsertDocumentStatusValueInput,
  adminUpsertDocumentStatusValueMutation,
  type AdminUpsertDocumentTypeInput,
  adminUpsertDocumentTypeMutation,
  type AdminUpsertDocumentVersionPolicyInput,
  adminUpsertDocumentVersionPolicyMutation,
} from "@myoxus/graphql";

import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";

export function useDocumentMetadataFieldDefinitionsQuery() {
  const response = useQuery({
    query: adminDocumentMetadataFieldDefinitionsQuery,
  });
  return {
    ...response,
    definitions: response.data?.admin.documentMetadataFieldDefinitions ?? [],
  };
}

export function useDocumentStatusSchemasQuery() {
  const response = useQuery({ query: adminDocumentStatusSchemasQuery });
  return {
    ...response,
    schemas: response.data?.admin.documentStatusSchemas ?? [],
  };
}

export function useDocumentStatusValuesQuery(schemaKey: string | null) {
  const response = useQuery(
    schemaKey
      ? { query: adminDocumentStatusValuesQuery, variables: { schemaKey } }
      : undefined,
  );
  return {
    ...response,
    values: response.data?.admin.documentStatusValues ?? [],
  };
}

export function useDocumentTypesQuery() {
  const response = useQuery({ query: adminDocumentTypesQuery });
  return {
    ...response,
    types: response.data?.admin.documentTypes ?? [],
  };
}

export function useDocumentRuntimeOverviewQuery() {
  const response = useQuery({ query: adminDocumentRuntimeOverviewQuery });
  return {
    ...response,
    overview: response.data?.admin.documentRuntimeOverview ?? null,
  };
}

export function useDocumentVersionPoliciesQuery() {
  const response = useQuery({ query: adminDocumentVersionPoliciesQuery });
  return {
    ...response,
    policies: response.data?.admin.documentVersionPolicies ?? [],
  };
}

export function useDocumentMetadataValueDefinitionsQuery(
  fieldKey: string | null,
) {
  const response = useQuery(
    fieldKey
      ? {
          query: adminDocumentMetadataValueDefinitionsQuery,
          variables: { fieldKey },
        }
      : undefined,
  );
  return {
    ...response,
    values: response.data?.admin.documentMetadataValueDefinitions ?? [],
  };
}

export function useDocumentAuditLogQuery(
  filter: AdminDocumentAuditFilterInput,
  pagination: { limit: number; offset: number } = { limit: 50, offset: 0 },
) {
  const response = useQuery({
    query: adminDocumentAuditLogQuery,
    variables: {
      filter,
      limit: pagination.limit,
      offset: pagination.offset,
    },
  });
  return {
    ...response,
    entries: response.data?.admin.adminDocumentAuditLog ?? [],
    totalCount: response.data?.admin.adminDocumentAuditLogCount ?? 0,
  };
}

export function useUpdateDocumentMetadataFieldDefinitionMutation() {
  const mutation = useMutation({
    mutation: adminUpdateDocumentMetadataFieldDefinitionMutation,
  });
  return {
    ...mutation,
    updateDefinition: (
      input: AdminUpdateDocumentMetadataFieldDefinitionInput,
    ) => mutation.trigger({ input }),
  };
}

export function useUpsertDocumentMetadataValueDefinitionMutation() {
  const mutation = useMutation({
    mutation: adminUpsertDocumentMetadataValueDefinitionMutation,
  });
  return {
    ...mutation,
    upsertValue: (input: AdminUpsertDocumentMetadataValueDefinitionInput) =>
      mutation.trigger({ input }),
  };
}

export function useUpsertDocumentStatusSchemaMutation() {
  const mutation = useMutation({
    mutation: adminUpsertDocumentStatusSchemaMutation,
  });
  return {
    ...mutation,
    upsertSchema: (input: AdminUpsertDocumentStatusSchemaInput) =>
      mutation.trigger({ input }),
  };
}

export function useUpsertDocumentStatusValueMutation() {
  const mutation = useMutation({
    mutation: adminUpsertDocumentStatusValueMutation,
  });
  return {
    ...mutation,
    upsertStatusValue: (input: AdminUpsertDocumentStatusValueInput) =>
      mutation.trigger({ input }),
  };
}

export function useUpsertDocumentStatusTransitionMutation() {
  const mutation = useMutation({
    mutation: adminUpsertDocumentStatusTransitionMutation,
  });
  return {
    ...mutation,
    upsertTransition: (input: AdminUpsertDocumentStatusTransitionInput) =>
      mutation.trigger({ input }),
  };
}

export function useUpsertDocumentTypeMutation() {
  const mutation = useMutation({ mutation: adminUpsertDocumentTypeMutation });
  return {
    ...mutation,
    upsertType: (input: AdminUpsertDocumentTypeInput) =>
      mutation.trigger({ input }),
  };
}

export function useUpsertDocumentVersionPolicyMutation() {
  const mutation = useMutation({
    mutation: adminUpsertDocumentVersionPolicyMutation,
  });
  return {
    ...mutation,
    upsertPolicy: (input: AdminUpsertDocumentVersionPolicyInput) =>
      mutation.trigger({ input }),
  };
}
