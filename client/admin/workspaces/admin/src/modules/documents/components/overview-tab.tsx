import { useI18n } from "@myoxus/i18n";
import {
  MetricCard,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsDetailHeader,
  SettingsStatusText,
  SettingsToolbar,
  SimpleGrid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@myoxus/ui-facade";

import {
  useDocumentMetadataFieldDefinitionsQuery,
  useDocumentRuntimeOverviewQuery,
  useDocumentStatusSchemasQuery,
  useDocumentTypesQuery,
  useDocumentVersionPoliciesQuery,
} from "../api";
import { ErrorText, KeyBadge } from "./shared";

type RuntimeBucket = {
  key?: string | null;
  label?: string | null;
  count: number;
};

function bucketLabel(i18n: ReturnType<typeof useI18n>, bucket: RuntimeBucket) {
  if (bucket.label) return bucket.label;
  if (!bucket.key) return i18n.t("admin.documents.overview.bucket.unset");
  const key = `admin.documents.overview.bucket.${bucket.key}`;
  const label = i18n.t(key);
  return label === key ? bucket.key : label;
}

export function OverviewTab() {
  const i18n = useI18n();
  const metadataFieldsQuery = useDocumentMetadataFieldDefinitionsQuery();
  const schemasQuery = useDocumentStatusSchemasQuery();
  const typesQuery = useDocumentTypesQuery();
  const policiesQuery = useDocumentVersionPoliciesQuery();
  const runtimeQuery = useDocumentRuntimeOverviewQuery();
  const overview = runtimeQuery.overview;

  const requiredMetadataFields = metadataFieldsQuery.definitions.filter(
    (definition) => definition.requiredMode !== "never",
  );
  const exportRequired = metadataFieldsQuery.definitions.filter(
    (definition) => definition.exportMode === "required",
  );
  const distributions = overview
    ? [
        { name: "status", buckets: overview.byStatus },
        { name: "types", buckets: overview.byDocumentType },
        { name: "classification", buckets: overview.byClassification },
        { name: "review", buckets: overview.byReviewDue },
        { name: "version", buckets: overview.byVersionState },
      ]
    : [];

  return (
    <Stack data-testid="documents-overview-tab">
      <SimpleGrid cols={5}>
        <MetricCard
          label={i18n.t("admin.documents.overview.metric.documents")}
          value={overview?.totalDocuments ?? "-"}
        />
        <MetricCard
          label={i18n.t("admin.documents.overview.metric.metadata-fields")}
          value={metadataFieldsQuery.definitions.length}
        />
        <MetricCard
          label={i18n.t("admin.documents.overview.metric.schemas")}
          value={schemasQuery.schemas.length}
        />
        <MetricCard
          label={i18n.t("admin.documents.overview.metric.types")}
          value={typesQuery.types.length}
        />
        <MetricCard
          label={i18n.t("admin.documents.overview.metric.policies")}
          value={policiesQuery.policies.length}
        />
      </SimpleGrid>

      <Stack component="section">
        <SettingsDetailHeader
          headingLevel={2}
          title={i18n.t("admin.documents.overview.runtime.title")}
          description={i18n.t("admin.documents.overview.runtime.description")}
        />
        {runtimeQuery.error ? (
          <ErrorText>{runtimeQuery.error.message}</ErrorText>
        ) : null}
        <SimpleGrid cols={3}>
          {distributions.map(({ name, buckets }) => {
            const title = i18n.t(`admin.documents.overview.${name}.title`);
            return (
              <Stack component="section" key={name}>
                <SettingsDetailHeader
                  headingLevel={3}
                  title={title}
                  description={i18n.t(
                    `admin.documents.overview.${name}.description`,
                  )}
                  divider={false}
                />
                {buckets.length === 0 ? (
                  <SettingsStatusText>
                    {i18n.t("admin.common.none")}
                  </SettingsStatusText>
                ) : (
                  <Table aria-label={title}>
                    <TableBody>
                      {buckets.map((bucket) => (
                        <TableRow key={bucket.key ?? "__unset"}>
                          <TableCell>{bucketLabel(i18n, bucket)}</TableCell>
                          <TableCell>{bucket.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Stack>
            );
          })}
        </SimpleGrid>
      </Stack>

      <SimpleGrid cols={2}>
        <Stack component="section">
          <SettingsDetailHeader
            headingLevel={2}
            title={i18n.t("admin.documents.overview.required.title")}
            description={i18n.t(
              "admin.documents.overview.required.description",
            )}
          />
          <SettingsDefinitionList>
            {requiredMetadataFields.map((definition) => (
              <SettingsDefinitionItem
                key={definition.key}
                label={definition.label}
              >
                <SettingsToolbar>
                  <KeyBadge value={definition.key} />
                  <KeyBadge value={definition.requiredMode} />
                </SettingsToolbar>
              </SettingsDefinitionItem>
            ))}
            {requiredMetadataFields.length === 0 ? (
              <SettingsStatusText>
                {i18n.t("admin.common.none")}
              </SettingsStatusText>
            ) : null}
          </SettingsDefinitionList>
        </Stack>
        <Stack component="section">
          <SettingsDetailHeader
            headingLevel={2}
            title={i18n.t("admin.documents.overview.export.title")}
            description={i18n.t("admin.documents.overview.export.description")}
          />
          <SettingsDefinitionList>
            {exportRequired.map((definition) => (
              <SettingsDefinitionItem
                key={definition.key}
                label={definition.label}
                mono
              >
                <KeyBadge value={definition.key} />
              </SettingsDefinitionItem>
            ))}
            {exportRequired.length === 0 ? (
              <SettingsStatusText>
                {i18n.t("admin.common.none")}
              </SettingsStatusText>
            ) : null}
          </SettingsDefinitionList>
        </Stack>
      </SimpleGrid>
    </Stack>
  );
}
