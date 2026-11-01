import { GraphQLService } from "@myoxus/core/modules/server";
import {
  type DocumentMetadataValueDefinitionsQuery,
  documentMetadataValueDefinitionsQuery,
  type DocumentStatusSchemasQuery,
  documentStatusSchemasQuery,
  type DocumentStatusValuesQuery,
  documentStatusValuesQuery,
  type DocumentTypesQuery,
  documentTypesQuery,
  type WorkspaceDocumentSettingsQuery,
  workspaceDocumentSettingsQuery,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { useEffect, useState } from "react";

export type GraphFilterOptions = {
  statuses: Array<{ value: string; label: string }>;
  documentTypes: Array<{ value: string; label: string }>;
  classifications: Array<{ value: string; label: string }>;
};

const EMPTY_FILTER_OPTIONS: GraphFilterOptions = {
  statuses: [],
  documentTypes: [],
  classifications: [],
};

export function useDocumentGraphFilterOptions(workspaceId: string) {
  const graphqlService = useService(GraphQLService);
  const [options, setOptions] =
    useState<GraphFilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadDocumentGraphFilterOptions(workspaceId, graphqlService)
      .then((nextOptions) => {
        if (!cancelled) setOptions(nextOptions);
      })
      .catch((error) => {
        console.warn("[document-graph] failed to load filter options", {
          workspaceId,
          error,
        });
        if (!cancelled) setOptions(EMPTY_FILTER_OPTIONS);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [graphqlService, workspaceId]);

  return { options, loading };
}

async function loadDocumentGraphFilterOptions(
  workspaceId: string,
  graphqlService: Pick<GraphQLService, "gql">,
): Promise<GraphFilterOptions> {
  const [settings, schemas, types, classifications] = await Promise.all([
    graphqlService.gql({
      query: workspaceDocumentSettingsQuery,
      variables: { workspaceId },
    } as never) as Promise<WorkspaceDocumentSettingsQuery>,
    graphqlService.gql({
      query: documentStatusSchemasQuery,
    } as never) as Promise<DocumentStatusSchemasQuery>,
    graphqlService.gql({
      query: documentTypesQuery,
    } as never) as Promise<DocumentTypesQuery>,
    graphqlService.gql({
      query: documentMetadataValueDefinitionsQuery,
      variables: { fieldKey: "classification" },
    } as never) as Promise<DocumentMetadataValueDefinitionsQuery>,
  ]);
  const activeSchema = schemas.documentStatusSchemas.find(
    (schema) =>
      schema.isActive &&
      schema.id === settings.workspaceDocumentSettings?.statusSchemaId,
  );
  const statusResponse = activeSchema
    ? ((await graphqlService.gql({
        query: documentStatusValuesQuery,
        variables: { schemaKey: activeSchema.key },
      } as never)) as DocumentStatusValuesQuery)
    : ({ documentStatusValues: [] } as DocumentStatusValuesQuery);

  return {
    statuses: statusResponse.documentStatusValues
      .filter((status) => status.isActive)
      .map((status) => ({ value: status.id, label: status.label })),
    documentTypes: types.documentTypes
      .filter((type) => type.isActive)
      .map((type) => ({ value: type.id, label: type.label })),
    classifications: classifications.documentMetadataValueDefinitions
      .filter((classification) => classification.isActive)
      .map((classification) => ({
        value: classification.id,
        label: classification.label,
      })),
  };
}
