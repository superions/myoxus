import { HEADER_METADATA_KEYS } from "@myoxus/core/modules/document-metadata/utils";
import type { CanonicalMetadataKey } from "@myoxus/core/modules/document-metadata/types";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { GraphQLService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  AutoVersionTriggerType,
  type DocumentMetadataFieldDefinitionsQuery,
  documentMetadataFieldDefinitionsQuery,
  type DocumentMetadataValueDefinitionsQuery,
  documentMetadataValueDefinitionsQuery,
  type DocumentStatusSchemasQuery,
  documentStatusSchemasQuery,
  type DocumentStatusValuesQuery,
  documentStatusValuesQuery,
  type DocumentTypesQuery,
  documentTypesQuery,
  type DocumentVersionPoliciesQuery,
  documentVersionPoliciesQuery,
  type UpdateWorkspaceDocumentSettingsInput,
  type UpdateWorkspaceDocumentSettingsMutation,
  type UpdateWorkspaceHistorySettingsInput,
  type UpdateWorkspaceHistorySettingsMutation,
  updateWorkspaceDocumentSettingsMutation,
  updateWorkspaceHistorySettingsMutation,
  type WorkspaceDocumentSettingsQuery,
  type WorkspaceHistorySettingsQuery,
  workspaceDocumentSettingsQuery,
  workspaceHistorySettingsQuery,
} from "@myoxus/graphql";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  BadgeList,
  BadgeListItem,
  Button,
  MyoxusSelect,
  NumberInput,
  MyoxusText,
  SettingsNotice,
  SettingsPage,
  SettingsField,
  SettingsRow,
  SettingsToolbar,
  SettingWrapper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../primitives";

const VALUE_LIST_KEYS = ["classification", "retentionPolicy"] as const;

const HEADER_METADATA_LABEL_KEYS: Record<CanonicalMetadataKey, string> = {
  status: "com.myoxus.document-metadata.field.status",
  documentType: "com.myoxus.document-metadata.field.document-type",
  version: "com.myoxus.document-metadata.field.version",
  responsible: "com.myoxus.document-metadata.field.responsible",
  reviewDueAt: "com.myoxus.document-metadata.field.review-due-at",
  validFrom: "com.myoxus.document-metadata.field.valid-from",
  validUntil: "com.myoxus.document-metadata.field.valid-until",
  classification: "com.myoxus.document-metadata.field.classification",
  documentNumber: "com.myoxus.document-metadata.field.document-number",
  language: "com.myoxus.document-metadata.field.language",
  audience: "com.myoxus.document-metadata.field.audience",
  retentionPolicy: "com.myoxus.document-metadata.field.retention-policy",
};

type WorkspaceDocumentSettings = NonNullable<
  WorkspaceDocumentSettingsQuery["workspaceDocumentSettings"]
>;
type StatusSchema = DocumentStatusSchemasQuery["documentStatusSchemas"][number];
type StatusValue = DocumentStatusValuesQuery["documentStatusValues"][number];
type DocumentType = DocumentTypesQuery["documentTypes"][number];
type VersionPolicy =
  DocumentVersionPoliciesQuery["documentVersionPolicies"][number];
type AttributeDefinition =
  DocumentMetadataFieldDefinitionsQuery["documentMetadataFieldDefinitions"][number];
type ValueDefinition =
  DocumentMetadataValueDefinitionsQuery["documentMetadataValueDefinitions"][number];

interface Bootstrap {
  settings: WorkspaceDocumentSettings;
  historySettings: WorkspaceHistorySettings;
  statusSchemas: StatusSchema[];
  statusValuesBySchemaKey: Record<string, StatusValue[]>;
  documentTypes: DocumentType[];
  versionPolicies: VersionPolicy[];
  definitions: AttributeDefinition[];
  valueLists: Record<(typeof VALUE_LIST_KEYS)[number], ValueDefinition[]>;
}

type WorkspaceHistorySettings =
  WorkspaceHistorySettingsQuery["workspaceHistorySettings"];

function emptySettings(workspaceId: string): WorkspaceDocumentSettings {
  return {
    workspaceId,
    statusSchemaId: null,
    defaultStatusId: null,
    versionPolicyId: null,
    defaultDocumentTypeId: null,
    defaultClassificationId: null,
    defaultRetentionPolicyId: null,
    updatedBy: null,
    updatedAt: "",
  };
}

function byId<T extends { id: string }>(
  items: T[],
  id: string | null | undefined,
) {
  return id ? (items.find((item) => item.id === id) ?? null) : null;
}

function activeStatusSchema(
  schemas: StatusSchema[],
  settings: WorkspaceDocumentSettings,
) {
  return (
    byId(schemas, settings.statusSchemaId) ??
    schemas.find((schema) => schema.key === "simple" && schema.isActive) ??
    schemas.find((schema) => schema.isActive) ??
    schemas[0] ??
    null
  );
}

function defaultStatusForNewDocument(statusValues: StatusValue[]) {
  return (
    statusValues.find((status) => status.isActive) ?? statusValues[0] ?? null
  );
}

function SelectRow({
  label,
  value,
  onChange,
  placeholder,
  data,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  data: Array<{ value: string; label: string }>;
}) {
  return (
    <SettingsRow name={label}>
      <MyoxusSelect
        aria-label={label}
        block
        data={[{ value: "", label: placeholder }, ...data]}
        onChange={onChange}
        value={value}
      />
    </SettingsRow>
  );
}

function VisibilityBadges({ definition }: { definition: AttributeDefinition }) {
  const t = useI18n();
  const entries = [
    definition.visibleInHeader
      ? t["com.myoxus.settings.workspace.documents.badge.header"]()
      : null,
    definition.visibleInProperties
      ? t["com.myoxus.settings.workspace.documents.badge.properties"]()
      : null,
    definition.visibleInLists
      ? t["com.myoxus.settings.workspace.documents.badge.lists"]()
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  if (entries.length === 0) {
    return (
      <MyoxusText tone="secondary" typographySlot="body-small">
        {t["com.myoxus.settings.workspace.documents.value.not-configured"]()}
      </MyoxusText>
    );
  }

  return (
    <BadgeList>
      {entries.map((entry) => (
        <BadgeListItem key={entry}>
          <Badge tone="neutral">{entry}</Badge>
        </BadgeListItem>
      ))}
    </BadgeList>
  );
}

function attributeLabel(
  t: ReturnType<typeof useI18n>,
  definition: AttributeDefinition,
) {
  if (definition.key in HEADER_METADATA_LABEL_KEYS) {
    return t[
      HEADER_METADATA_LABEL_KEYS[definition.key as CanonicalMetadataKey]
    ]();
  }

  switch (definition.key) {
    case "createdAt":
      return t["com.myoxus.document-metadata.field.created-at"]();
    case "createdBy":
      return t["com.myoxus.document-metadata.field.created-by"]();
    case "edgelessColorTheme":
      return t["com.myoxus.document-metadata.field.edgeless-color-theme"]();
    case "integrationType":
      return t["com.myoxus.document-metadata.field.integration-type"]();
    case "journalDate":
      return t["com.myoxus.document-metadata.field.journal-date"]();
    case "metadataRevision":
      return t["com.myoxus.document-metadata.field.metadata-revision"]();
    case "pageWidth":
      return t["com.myoxus.document-metadata.field.page-width"]();
    case "primaryMode":
      return t["com.myoxus.document-metadata.field.primary-mode"]();
    case "templateState":
      return t["com.myoxus.document-metadata.field.template-state"]();
    case "updatedAt":
      return t["com.myoxus.document-metadata.field.updated-at"]();
    case "updatedBy":
      return t["com.myoxus.document-metadata.field.updated-by"]();
    default:
      return definition.label;
  }
}

function HeaderVisibilitySettings({
  definitions,
  overrides,
  onChange,
}: {
  definitions: AttributeDefinition[];
  overrides: Partial<Record<CanonicalMetadataKey, boolean>>;
  onChange: (key: CanonicalMetadataKey, visible: boolean) => void;
}) {
  const t = useI18n();
  const definitionByKey = useMemo(
    () =>
      new Map(definitions.map((definition) => [definition.key, definition])),
    [definitions],
  );

  return (
    <SettingWrapper
      title={t["com.myoxus.document-metadata.section.label-visibility"]()}
    >
      {HEADER_METADATA_KEYS.map((key) => {
        const definition = definitionByKey.get(key);
        const fallback = t[HEADER_METADATA_LABEL_KEYS[key]]();
        const label = definition?.label?.trim() || fallback;
        const serverVisible = Boolean(
          definition?.enabled && definition.visibleInHeader,
        );
        const checked = serverVisible && (overrides[key] ?? true);
        return (
          <SettingsRow key={key} name={label} disabled={!serverVisible}>
            <Switch
              aria-label={t[
                "com.myoxus.document-metadata.label-visibility.toggle"
              ]({ label })}
              checked={checked}
              disabled={!serverVisible}
              onChange={(visible) => onChange(key, visible)}
              testId={`document-metadata-header-visibility-${key}`}
              variant="pill"
            />
          </SettingsRow>
        );
      })}
    </SettingWrapper>
  );
}

async function loadBootstrap(
  workspaceId: string,
  graphqlService: Pick<GraphQLService, "gql">,
): Promise<Bootstrap> {
  const [
    settingsResponse,
    schemasResponse,
    typesResponse,
    policiesResponse,
    definitionsResponse,
    classificationResponse,
    retentionResponse,
    historySettingsResponse,
  ] = await Promise.all([
    graphqlService.gql({
      query: workspaceDocumentSettingsQuery,
      variables: { workspaceId },
    }),
    graphqlService.gql({ query: documentStatusSchemasQuery }),
    graphqlService.gql({ query: documentTypesQuery }),
    graphqlService.gql({
      query: documentVersionPoliciesQuery,
      variables: { workspaceId },
    }),
    graphqlService.gql({ query: documentMetadataFieldDefinitionsQuery }),
    graphqlService.gql({
      query: documentMetadataValueDefinitionsQuery,
      variables: { fieldKey: "classification" },
    }),
    graphqlService.gql({
      query: documentMetadataValueDefinitionsQuery,
      variables: { fieldKey: "retentionPolicy" },
    }),
    graphqlService.gql({
      query: workspaceHistorySettingsQuery,
      variables: { workspaceId },
    }),
  ]);
  const settings =
    (settingsResponse as WorkspaceDocumentSettingsQuery)
      .workspaceDocumentSettings ?? emptySettings(workspaceId);
  const statusSchemas = (schemasResponse as DocumentStatusSchemasQuery)
    .documentStatusSchemas;
  const statusValueEntries = await Promise.all(
    statusSchemas
      .filter((schema) => schema.isActive)
      .map(async (schema) => {
        const response = await graphqlService.gql({
          query: documentStatusValuesQuery,
          variables: { schemaKey: schema.key },
        });
        return [
          schema.key,
          (response as DocumentStatusValuesQuery).documentStatusValues,
        ] as const;
      }),
  );

  return {
    settings,
    historySettings: (historySettingsResponse as WorkspaceHistorySettingsQuery)
      .workspaceHistorySettings,
    statusSchemas,
    statusValuesBySchemaKey: Object.fromEntries(statusValueEntries),
    documentTypes: (typesResponse as DocumentTypesQuery).documentTypes,
    versionPolicies: (policiesResponse as DocumentVersionPoliciesQuery)
      .documentVersionPolicies,
    definitions: (definitionsResponse as DocumentMetadataFieldDefinitionsQuery)
      .documentMetadataFieldDefinitions,
    valueLists: {
      classification: (
        classificationResponse as DocumentMetadataValueDefinitionsQuery
      ).documentMetadataValueDefinitions.filter((value) => value.isActive),
      retentionPolicy: (
        retentionResponse as DocumentMetadataValueDefinitionsQuery
      ).documentMetadataValueDefinitions.filter((value) => value.isActive),
    },
  };
}

const MIN_HISTORY_INTERVAL_MINUTES = 15;
const MAX_HISTORY_INTERVAL_MINUTES = 24 * 60;

function HistoryAutomationSettings({
  workspaceId,
  graphqlService,
  initial,
}: {
  workspaceId: string;
  graphqlService: Pick<GraphQLService, "gql">;
  initial: WorkspaceHistorySettings;
}) {
  const t = useI18n();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = [
    "namedVersioningEnabled",
    "autoVersionOn",
    "retentionCount",
    "editCaptureEnabled",
    "editCaptureIntervalMs",
  ] as const;
  const dirty = fields.some(
    (field) => JSON.stringify(saved[field]) !== JSON.stringify(draft[field]),
  );
  const hasWorkspaceOverride = fields.some((field) => saved[field] !== null);
  const intervalMinutes =
    (draft.editCaptureIntervalMs ?? draft.effectiveEditCaptureIntervalMs) /
    60_000;
  const intervalInvalid =
    draft.editCaptureIntervalMs !== null &&
    (intervalMinutes < MIN_HISTORY_INTERVAL_MINUTES ||
      intervalMinutes > MAX_HISTORY_INTERVAL_MINUTES);
  const effectiveTriggers = draft.autoVersionOn ?? draft.effectiveAutoVersionOn;

  const boolModeData = (effective: boolean) => [
    {
      value: "inherit",
      label: t["com.myoxus.settings.workspace.documents.history.mode.inherit"]({
        value: effective
          ? t["com.myoxus.settings.workspace.documents.history.value.enabled"]()
          : t[
              "com.myoxus.settings.workspace.documents.history.value.disabled"
            ](),
      }),
    },
    {
      value: "enabled",
      label:
        t["com.myoxus.settings.workspace.documents.history.mode.enabled"](),
    },
    {
      value: "disabled",
      label:
        t["com.myoxus.settings.workspace.documents.history.mode.disabled"](),
    },
  ];

  const updateTrigger = (trigger: AutoVersionTriggerType, enabled: boolean) => {
    setDraft((current) => {
      const triggers = new Set(
        current.autoVersionOn ?? current.effectiveAutoVersionOn,
      );
      if (enabled) triggers.add(trigger);
      else triggers.delete(trigger);
      return { ...current, autoVersionOn: [...triggers] };
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (intervalInvalid) {
      setError(
        t["com.myoxus.settings.workspace.documents.history.error.minimum"](),
      );
      return;
    }
    const input: UpdateWorkspaceHistorySettingsInput = {
      expectedRevision: saved.revision,
      ...(saved.namedVersioningEnabled !== draft.namedVersioningEnabled
        ? { namedVersioningEnabled: draft.namedVersioningEnabled }
        : {}),
      ...(JSON.stringify(saved.autoVersionOn) !==
      JSON.stringify(draft.autoVersionOn)
        ? { autoVersionOn: draft.autoVersionOn }
        : {}),
      ...(saved.retentionCount !== draft.retentionCount
        ? { retentionCount: draft.retentionCount }
        : {}),
      ...(saved.editCaptureEnabled !== draft.editCaptureEnabled
        ? { editCaptureEnabled: draft.editCaptureEnabled }
        : {}),
      ...(saved.editCaptureIntervalMs !== draft.editCaptureIntervalMs
        ? { editCaptureIntervalMs: draft.editCaptureIntervalMs }
        : {}),
    };
    setSaving(true);
    setError(null);
    try {
      const response = (await graphqlService.gql({
        query: updateWorkspaceHistorySettingsMutation,
        variables: { workspaceId, input },
      })) as UpdateWorkspaceHistorySettingsMutation;
      setSaved(response.updateWorkspaceHistorySettings);
      setDraft(response.updateWorkspaceHistorySettings);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t["com.myoxus.settings.workspace.documents.error.save"](),
      );
    } finally {
      setSaving(false);
    }
  };

  const resetToServer = () => {
    setDraft((current) => ({
      ...current,
      namedVersioningEnabled: null,
      autoVersionOn: null,
      retentionCount: null,
      editCaptureEnabled: null,
      editCaptureIntervalMs: null,
    }));
  };

  return (
    <Stack component="form" onSubmit={submit}>
      <SettingWrapper
        id="automatic-capture"
        title={t[
          "com.myoxus.settings.workspace.documents.history.section.automatic"
        ]()}
      >
        {!draft.runtimeAvailable ? (
          <SettingsNotice tone="warning">
            {t[
              "com.myoxus.settings.workspace.documents.history.notice.pending"
            ]()}
          </SettingsNotice>
        ) : draft.lastEditCaptureAt ? (
          <SettingsNotice>
            {t[
              "com.myoxus.settings.workspace.documents.history.notice.last-capture"
            ]({
              date: i18nTime(draft.lastEditCaptureAt, {
                absolute: { accuracy: "minute" },
              }),
            })}
          </SettingsNotice>
        ) : (
          <SettingsNotice>
            {t[
              "com.myoxus.settings.workspace.documents.history.notice.no-capture"
            ]()}
          </SettingsNotice>
        )}
        {draft.legacyIntervalNormalized ? (
          <SettingsNotice>
            {t[
              "com.myoxus.settings.workspace.documents.history.notice.legacy"
            ]()}
          </SettingsNotice>
        ) : null}
        <SettingsField
          inline
          label={t[
            "com.myoxus.settings.workspace.documents.history.field.automatic"
          ]()}
        >
          <MyoxusSelect
            aria-label={t[
              "com.myoxus.settings.workspace.documents.history.field.automatic"
            ]()}
            block
            data={boolModeData(draft.effectiveEditCaptureEnabled)}
            value={
              draft.editCaptureEnabled === null
                ? "inherit"
                : draft.editCaptureEnabled
                  ? "enabled"
                  : "disabled"
            }
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                editCaptureEnabled:
                  value === "inherit" ? null : value === "enabled",
              }))
            }
          />
        </SettingsField>
        <SettingsField
          inline
          label={t[
            "com.myoxus.settings.workspace.documents.history.field.interval"
          ]()}
        >
          <Stack>
            <MyoxusSelect
              aria-label={t[
                "com.myoxus.settings.workspace.documents.history.field.interval"
              ]()}
              block
              data={[
                {
                  value: "inherit",
                  label: t[
                    "com.myoxus.settings.workspace.documents.history.mode.inherit"
                  ]({
                    value: String(
                      draft.effectiveEditCaptureIntervalMs / 60_000,
                    ),
                  }),
                },
                {
                  value: "custom",
                  label:
                    t[
                      "com.myoxus.settings.workspace.documents.history.mode.custom"
                    ](),
                },
              ]}
              value={
                draft.editCaptureIntervalMs === null ? "inherit" : "custom"
              }
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  editCaptureIntervalMs:
                    value === "inherit"
                      ? null
                      : current.effectiveEditCaptureIntervalMs,
                }))
              }
            />
            {draft.editCaptureIntervalMs !== null ? (
              <NumberInput
                aria-label={t[
                  "com.myoxus.settings.workspace.documents.history.field.interval"
                ]()}
                data-testid="workspace-history-interval-minutes"
                error={
                  intervalInvalid
                    ? t[
                        "com.myoxus.settings.workspace.documents.history.error.minimum"
                      ]()
                    : undefined
                }
                min={MIN_HISTORY_INTERVAL_MINUTES}
                max={MAX_HISTORY_INTERVAL_MINUTES}
                value={intervalMinutes}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    editCaptureIntervalMs:
                      typeof value === "number"
                        ? Math.round(value * 60_000)
                        : current.editCaptureIntervalMs,
                  }))
                }
              />
            ) : null}
          </Stack>
        </SettingsField>
      </SettingWrapper>

      <SettingWrapper
        title={t[
          "com.myoxus.settings.workspace.documents.history.section.events"
        ]()}
      >
        <SettingsField
          inline
          label={t[
            "com.myoxus.settings.workspace.documents.history.field.named-enabled"
          ]()}
        >
          <MyoxusSelect
            aria-label={t[
              "com.myoxus.settings.workspace.documents.history.field.named-enabled"
            ]()}
            block
            data={boolModeData(draft.effectiveNamedVersioningEnabled)}
            value={
              draft.namedVersioningEnabled === null
                ? "inherit"
                : draft.namedVersioningEnabled
                  ? "enabled"
                  : "disabled"
            }
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                namedVersioningEnabled:
                  value === "inherit" ? null : value === "enabled",
              }))
            }
          />
        </SettingsField>
        <SettingsField
          inline
          label={t[
            "com.myoxus.settings.workspace.documents.history.field.triggers"
          ]()}
        >
          <MyoxusSelect
            aria-label={t[
              "com.myoxus.settings.workspace.documents.history.field.triggers"
            ]()}
            block
            data={[
              {
                value: "inherit",
                label: t[
                  "com.myoxus.settings.workspace.documents.history.mode.inherit"
                ]({ value: String(draft.effectiveAutoVersionOn.length) }),
              },
              {
                value: "custom",
                label:
                  t[
                    "com.myoxus.settings.workspace.documents.history.mode.custom"
                  ](),
              },
            ]}
            value={draft.autoVersionOn === null ? "inherit" : "custom"}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                autoVersionOn:
                  value === "inherit"
                    ? null
                    : [...current.effectiveAutoVersionOn],
              }))
            }
          />
        </SettingsField>
        <SettingsRow
          name={t[
            "com.myoxus.settings.workspace.documents.history.field.publish"
          ]()}
        >
          <Switch
            aria-label={t[
              "com.myoxus.settings.workspace.documents.history.field.publish"
            ]()}
            checked={effectiveTriggers.includes(
              AutoVersionTriggerType.on_publish,
            )}
            disabled={draft.autoVersionOn === null}
            onChange={(checked) =>
              updateTrigger(AutoVersionTriggerType.on_publish, checked)
            }
            variant="pill"
          />
        </SettingsRow>
        <SettingsRow
          name={t[
            "com.myoxus.settings.workspace.documents.history.field.pdf"
          ]()}
        >
          <Switch
            aria-label={t[
              "com.myoxus.settings.workspace.documents.history.field.pdf"
            ]()}
            checked={effectiveTriggers.includes(
              AutoVersionTriggerType.on_pdf_export,
            )}
            disabled={draft.autoVersionOn === null}
            onChange={(checked) =>
              updateTrigger(AutoVersionTriggerType.on_pdf_export, checked)
            }
            variant="pill"
          />
        </SettingsRow>
        <SettingsRow
          name={t[
            "com.myoxus.settings.workspace.documents.history.field.daily"
          ]()}
        >
          <Switch
            aria-label={t[
              "com.myoxus.settings.workspace.documents.history.field.daily"
            ]()}
            checked={effectiveTriggers.includes(AutoVersionTriggerType.daily)}
            disabled={draft.autoVersionOn === null}
            onChange={(checked) =>
              updateTrigger(AutoVersionTriggerType.daily, checked)
            }
            variant="pill"
          />
        </SettingsRow>
        <SettingsField
          inline
          label={t[
            "com.myoxus.settings.workspace.documents.history.field.retention"
          ]()}
        >
          <Stack>
            <MyoxusSelect
              aria-label={t[
                "com.myoxus.settings.workspace.documents.history.field.retention"
              ]()}
              block
              data={[
                {
                  value: "inherit",
                  label: t[
                    "com.myoxus.settings.workspace.documents.history.mode.inherit"
                  ]({ value: String(draft.effectiveRetentionCount) }),
                },
                {
                  value: "custom",
                  label:
                    t[
                      "com.myoxus.settings.workspace.documents.history.mode.custom"
                    ](),
                },
              ]}
              value={draft.retentionCount === null ? "inherit" : "custom"}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  retentionCount:
                    value === "inherit"
                      ? null
                      : current.effectiveRetentionCount,
                }))
              }
            />
            {draft.retentionCount !== null ? (
              <NumberInput
                aria-label={t[
                  "com.myoxus.settings.workspace.documents.history.field.retention"
                ]()}
                min={1}
                max={50}
                value={draft.retentionCount}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    retentionCount:
                      typeof value === "number" ? Math.round(value) : null,
                  }))
                }
              />
            ) : null}
          </Stack>
        </SettingsField>
        <SettingsNotice>
          {t[
            "com.myoxus.settings.workspace.documents.history.retention-help"
          ]()}
        </SettingsNotice>
      </SettingWrapper>

      {error ? (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      ) : null}
      {dirty || hasWorkspaceOverride ? (
        <SettingsToolbar justify="flex-end">
          {hasWorkspaceOverride ? (
            <Button type="button" variant="secondary" onClick={resetToServer}>
              {t[
                "com.myoxus.settings.workspace.documents.history.action.server-default"
              ]()}
            </Button>
          ) : null}
          {dirty ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(saved);
                  setError(null);
                }}
              >
                {t.Cancel()}
              </Button>
              <Button
                data-testid="workspace-history-settings-save"
                disabled={saving || intervalInvalid}
                type="submit"
                variant="primary"
              >
                {t[
                  "com.myoxus.settings.workspace.documents.history.action.save"
                ]()}
              </Button>
            </>
          ) : null}
        </SettingsToolbar>
      ) : null}
    </Stack>
  );
}

export function WorkspaceDocumentsSettingsView({
  workspaceId,
  graphqlService,
  headerVisibilityOverrides,
  onSetHeaderVisibilityOverride,
}: {
  workspaceId: string;
  graphqlService: Pick<GraphQLService, "gql">;
  headerVisibilityOverrides: Partial<Record<CanonicalMetadataKey, boolean>>;
  onSetHeaderVisibilityOverride: (
    key: CanonicalMetadataKey,
    visible: boolean,
  ) => void;
}) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [draft, setDraft] = useState<WorkspaceDocumentSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const t = useI18n();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBootstrap(null);
    setDraft(null);
    void loadBootstrap(workspaceId, graphqlService)
      .then((data) => {
        if (cancelled) return;
        console.info("[document-settings] workspace document settings loaded", {
          workspaceId,
          statusSchemas: data.statusSchemas.length,
          documentTypes: data.documentTypes.length,
          versionPolicies: data.versionPolicies.length,
        });
        setBootstrap(data);
        setDraft(data.settings);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          "[document-settings] failed to load workspace document settings",
          { workspaceId, error: err },
        );
        setError(
          err instanceof Error
            ? err.message
            : t["com.myoxus.settings.workspace.documents.error.load"](),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [graphqlService, reloadKey, t, workspaceId]);

  const statusSchema = useMemo(
    () =>
      bootstrap && draft
        ? activeStatusSchema(bootstrap.statusSchemas, draft)
        : null,
    [bootstrap, draft],
  );
  const dirty = Boolean(
    bootstrap &&
    draft &&
    JSON.stringify(bootstrap.settings) !== JSON.stringify(draft),
  );

  const setField = useCallback(
    <K extends keyof WorkspaceDocumentSettings>(
      key: K,
      value: WorkspaceDocumentSettings[K],
    ) => {
      setDraft((old) => (old ? { ...old, [key]: value } : old));
    },
    [],
  );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    const input: UpdateWorkspaceDocumentSettingsInput = {
      statusSchemaId: draft.statusSchemaId,
      defaultStatusId: draft.defaultStatusId,
      versionPolicyId: draft.versionPolicyId,
      defaultDocumentTypeId: draft.defaultDocumentTypeId,
      defaultClassificationId: draft.defaultClassificationId,
      defaultRetentionPolicyId: draft.defaultRetentionPolicyId,
    };
    try {
      const response = (await graphqlService.gql({
        query: updateWorkspaceDocumentSettingsMutation,
        variables: { workspaceId, input },
      })) as UpdateWorkspaceDocumentSettingsMutation;
      const settings = response.updateWorkspaceDocumentSettings;
      console.info("[document-settings] workspace document settings saved", {
        workspaceId,
        statusSchemaId: settings.statusSchemaId,
        defaultStatusId: settings.defaultStatusId,
        versionPolicyId: settings.versionPolicyId,
      });
      setBootstrap((old) => (old ? { ...old, settings } : old));
      setDraft(settings);
    } catch (err) {
      console.warn(
        "[document-settings] workspace document settings save failed",
        {
          workspaceId,
          error: err,
        },
      );
      setError(
        err instanceof Error
          ? err.message
          : t["com.myoxus.settings.workspace.documents.error.save"](),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage
      title={t["com.myoxus.settings.workspace.documents.header.title"]()}
      subtitle={t["com.myoxus.settings.workspace.documents.header.subtitle"]()}
      testId="settings-page-workspace-documents"
    >
      {error ? (
        <SettingsNotice tone="error" role="alert">
          {error}
        </SettingsNotice>
      ) : null}

      {!bootstrap || !draft ? (
        <SettingWrapper
          title={t[
            "com.myoxus.settings.workspace.documents.section.settings"
          ]()}
        >
          <MyoxusText tone="secondary" typographySlot="body-small">
            {t["com.myoxus.settings.workspace.documents.loading"]()}
          </MyoxusText>
        </SettingWrapper>
      ) : (
        <Stack>
          <HistoryAutomationSettings
            graphqlService={graphqlService}
            initial={bootstrap.historySettings}
            workspaceId={workspaceId}
          />
          <Stack component="form" onSubmit={save}>
            <SettingWrapper
              title={t[
                "com.myoxus.settings.workspace.documents.section.defaults"
              ]()}
            >
              <SelectRow
                label={t[
                  "com.myoxus.settings.workspace.documents.field.status-schema"
                ]()}
                onChange={(value) =>
                  setDraft((old) => {
                    if (!old) return old;
                    const nextSchemaId = value ? value : null;
                    const nextSchema = bootstrap.statusSchemas.find(
                      (schema) => schema.id === nextSchemaId,
                    );
                    const nextDefaultStatus = nextSchema
                      ? defaultStatusForNewDocument(
                          bootstrap.statusValuesBySchemaKey[nextSchema.key] ??
                            [],
                        )
                      : null;
                    return {
                      ...old,
                      statusSchemaId: nextSchemaId,
                      defaultStatusId: nextDefaultStatus?.id ?? null,
                    };
                  })
                }
                placeholder={t[
                  "com.myoxus.settings.workspace.documents.field.server-default"
                ]()}
                value={draft.statusSchemaId ?? ""}
                data={bootstrap.statusSchemas
                  .filter((schema) => schema.isActive)
                  .map((schema) => ({
                    value: schema.id,
                    label: schema.label,
                  }))}
              />
              <SelectRow
                label={t[
                  "com.myoxus.settings.workspace.documents.field.default-status"
                ]()}
                onChange={(value) =>
                  setField("defaultStatusId", value ? value : null)
                }
                placeholder={t[
                  "com.myoxus.settings.workspace.documents.field.server-default"
                ]()}
                value={draft.defaultStatusId ?? ""}
                data={(statusSchema
                  ? (bootstrap.statusValuesBySchemaKey[statusSchema.key] ?? [])
                  : []
                )
                  .filter((status) => status.isActive)
                  .map((status) => ({
                    value: status.id,
                    label: status.label,
                  }))}
              />
              <SelectRow
                label={t[
                  "com.myoxus.settings.workspace.documents.field.versioning-policy"
                ]()}
                onChange={(value) =>
                  setField("versionPolicyId", value ? value : null)
                }
                placeholder={t[
                  "com.myoxus.settings.workspace.documents.field.server-default"
                ]()}
                value={draft.versionPolicyId ?? ""}
                data={bootstrap.versionPolicies.map((policy) => ({
                  value: policy.id,
                  label: policy.name,
                }))}
              />
              <SelectRow
                label={t[
                  "com.myoxus.settings.workspace.documents.field.default-document-type"
                ]()}
                onChange={(value) =>
                  setField("defaultDocumentTypeId", value ? value : null)
                }
                placeholder={t[
                  "com.myoxus.settings.workspace.documents.field.server-default"
                ]()}
                value={draft.defaultDocumentTypeId ?? ""}
                data={bootstrap.documentTypes
                  .filter((type) => type.isActive)
                  .map((type) => ({
                    value: type.id,
                    label: type.label,
                  }))}
              />
              <SelectRow
                label={t[
                  "com.myoxus.settings.workspace.documents.field.default-classification"
                ]()}
                onChange={(value) =>
                  setField("defaultClassificationId", value ? value : null)
                }
                placeholder={t[
                  "com.myoxus.settings.workspace.documents.field.server-default"
                ]()}
                value={draft.defaultClassificationId ?? ""}
                data={bootstrap.valueLists.classification.map((value) => ({
                  value: value.id,
                  label: value.label,
                }))}
              />
              <SelectRow
                label={t[
                  "com.myoxus.settings.workspace.documents.field.default-retention"
                ]()}
                onChange={(value) =>
                  setField("defaultRetentionPolicyId", value ? value : null)
                }
                placeholder={t[
                  "com.myoxus.settings.workspace.documents.field.server-default"
                ]()}
                value={draft.defaultRetentionPolicyId ?? ""}
                data={bootstrap.valueLists.retentionPolicy.map((value) => ({
                  value: value.id,
                  label: value.label,
                }))}
              />
              {dirty ? (
                <SettingsToolbar justify="flex-end">
                  <Button
                    data-myoxus-ui-role="button:compact"
                    disabled={saving}
                    onClick={() => setDraft(bootstrap.settings)}
                    type="button"
                    variant="secondary"
                  >
                    {t[
                      "com.myoxus.settings.workspace.documents.action.reset"
                    ]()}
                  </Button>
                  <Button
                    data-myoxus-ui-role="button:compact"
                    disabled={saving}
                    type="submit"
                    variant="primary"
                  >
                    {saving
                      ? t[
                          "com.myoxus.settings.workspace.documents.action.saving"
                        ]()
                      : t[
                          "com.myoxus.settings.workspace.documents.action.save"
                        ]()}
                  </Button>
                </SettingsToolbar>
              ) : null}
            </SettingWrapper>

            <HeaderVisibilitySettings
              definitions={bootstrap.definitions}
              overrides={headerVisibilityOverrides}
              onChange={onSetHeaderVisibilityOverride}
            />

            <Accordion variant="contained">
              <AccordionItem value="attribute-policy">
                <AccordionControl>
                  {t[
                    "com.myoxus.settings.workspace.documents.section.override-policy"
                  ]()}
                </AccordionControl>
                <AccordionPanel flushHorizontal>
                  <Stack>
                    <SettingsNotice
                      title={t[
                        "com.myoxus.settings.workspace.documents.notice.title"
                      ]()}
                    >
                      {t[
                        "com.myoxus.settings.workspace.documents.notice.text"
                      ]()}
                    </SettingsNotice>
                    <Table withColumnBorders={false} withRowBorders>
                      <TableHeader>
                        <TableRow data-myoxus-ui-role="settings-table-header-row">
                          <TableHead data-myoxus-ui-role="settings-table-header">
                            {t[
                              "com.myoxus.settings.workspace.documents.table.attribute"
                            ]()}
                          </TableHead>
                          <TableHead data-myoxus-ui-role="settings-table-header">
                            {t[
                              "com.myoxus.settings.workspace.documents.table.visibility"
                            ]()}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bootstrap.definitions.map((definition) => (
                          <TableRow
                            key={definition.key}
                            data-myoxus-ui-role="settings-table-row"
                          >
                            <TableCell data-myoxus-ui-role="settings-table-cell">
                              <MyoxusText typographySlot="body">
                                {attributeLabel(t, definition)}
                              </MyoxusText>
                            </TableCell>
                            <TableCell data-myoxus-ui-role="settings-table-cell">
                              <VisibilityBadges definition={definition} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </Stack>
        </Stack>
      )}

      {error ? (
        <Button
          data-myoxus-ui-role="button:compact"
          onClick={() => setReloadKey((key) => key + 1)}
          type="button"
          variant="secondary"
        >
          {t["Retry"]()}
        </Button>
      ) : null}
    </SettingsPage>
  );
}

export function WorkspaceDocumentsSettings() {
  const workspace = useService(WorkspaceService).workspace;
  const graphqlService = useService(GraphQLService);
  const editorSettingService = useService(EditorSettingService);
  const settings = useLiveData(editorSettingService.editorSetting.settings$);
  const headerVisibilityOverrides =
    settings.documentMetadataHeaderVisibility[workspace.id] ?? {};
  const onSetHeaderVisibilityOverride = useCallback(
    (key: CanonicalMetadataKey, visible: boolean) => {
      const current = editorSettingService.editorSetting.get(
        "documentMetadataHeaderVisibility",
      );
      editorSettingService.editorSetting.set(
        "documentMetadataHeaderVisibility",
        {
          ...current,
          [workspace.id]: {
            ...current[workspace.id],
            [key]: visible,
          },
        },
      );
    },
    [editorSettingService, workspace.id],
  );

  return (
    <WorkspaceDocumentsSettingsView
      graphqlService={graphqlService}
      headerVisibilityOverrides={headerVisibilityOverrides}
      onSetHeaderVisibilityOverride={onSetHeaderVisibilityOverride}
      workspaceId={workspace.id}
    />
  );
}
