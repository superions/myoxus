import type {
  AdminUpdateDocumentMetadataFieldDefinitionInput,
  DocumentMetadataFieldDefinitionFieldsFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { SearchIcon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  NavigationLink,
  Input,
  Select,
  SettingsCollectionToolbar,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsMasterDetailLayout,
  SettingsNotice,
  SettingsStatusText,
  SettingsSwitchRow,
  SettingsToolbar,
  SimpleGrid,
  Stack,
  SurfaceList,
  Textarea,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";

import {
  useDocumentMetadataFieldDefinitionsQuery,
  useUpdateDocumentMetadataFieldDefinitionMutation,
} from "../api";
import { asJson, fieldError, parseJsonField } from "./shared";

const REQUIRED_MODES = [
  "never",
  "always",
  "by_status",
  "by_type",
  "by_status_and_type",
];
const EDITABLE_BY = ["editor", "responsible", "workspace_admin", "admin_only"];
const EXPORT_MODES = ["hidden", "optional", "required"];

function toDraft(definition: DocumentMetadataFieldDefinitionFieldsFragment) {
  return {
    key: definition.key,
    label: definition.label,
    enabled: definition.enabled,
    requiredMode: definition.requiredMode,
    editableBy: definition.editableBy,
    visibleInHeader: definition.visibleInHeader,
    visibleInProperties: definition.visibleInProperties,
    visibleInLists: definition.visibleInLists,
    exportMode: definition.exportMode,
    validationConfig: asJson(definition.validationConfig),
    metadata: asJson(definition.metadata),
  };
}

type MetadataFieldDraft = ReturnType<typeof toDraft>;

function MetadataFieldEditor({
  definition,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  definition: DocumentMetadataFieldDefinitionFieldsFragment;
  onSaved: () => Promise<unknown>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const i18n = useI18n();
  const [draft, setDraft] = useState<MetadataFieldDraft>(() =>
    toDraft(definition),
  );
  const initializedDefinition = useRef(definition);
  const [baseline, setBaseline] = useState(() => toDraft(definition));
  const [expanded, setExpanded] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const mutation = useUpdateDocumentMetadataFieldDefinitionMutation();
  const requiredModeLabels = {
    never: i18n.t("admin.documents.required-mode.never"),
    always: i18n.t("admin.documents.required-mode.always"),
    by_status: i18n.t("admin.documents.required-mode.by_status"),
    by_type: i18n.t("admin.documents.required-mode.by_type"),
    by_status_and_type: i18n.t(
      "admin.documents.required-mode.by_status_and_type",
    ),
  };
  const editableByLabels = {
    editor: i18n.t("admin.documents.editable-by.editor"),
    responsible: i18n.t("admin.documents.editable-by.responsible"),
    workspace_admin: i18n.t("admin.documents.editable-by.workspace_admin"),
    admin_only: i18n.t("admin.documents.editable-by.admin_only"),
  };
  const exportModeLabels = {
    hidden: i18n.t("admin.documents.export-mode.hidden"),
    optional: i18n.t("admin.documents.export-mode.optional"),
    required: i18n.t("admin.documents.export-mode.required"),
  };

  const clean = useMemo(() => toDraft(definition), [definition]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(saving), [saving, onBusyChange]);
  useEffect(() => {
    if (
      fieldError(mutation.error, "validationConfig") ||
      fieldError(mutation.error, "metadata")
    )
      setExpanded(["validation", "metadata"]);
  }, [mutation.error]);
  useEffect(() => {
    // Re-entering an Activity tab or receiving readback must not erase a draft.
    if (initializedDefinition.current === definition || dirtyRef.current)
      return;
    initializedDefinition.current = definition;
    setBaseline(toDraft(definition));
    setDraft(toDraft(definition));
    setJsonError(null);
  }, [definition]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setJsonError(null);

    let validationConfig: unknown;
    let metadata: unknown;
    try {
      validationConfig = parseJsonField(draft.validationConfig);
      metadata = parseJsonField(draft.metadata);
    } catch (error) {
      setExpanded(["validation", "metadata"]);
      setJsonError(error instanceof Error ? error.message : String(error));
      return;
    }

    const input: AdminUpdateDocumentMetadataFieldDefinitionInput = {
      key: draft.key,
      label: draft.label,
      enabled: draft.enabled,
      requiredMode: draft.requiredMode,
      editableBy: draft.editableBy,
      visibleInHeader: draft.visibleInHeader,
      visibleInProperties: draft.visibleInProperties,
      visibleInLists: draft.visibleInLists,
      exportMode: draft.exportMode,
      validationConfig,
      metadata,
    };

    setSaving(true);
    setSaveError(null);
    try {
      await mutation.updateDefinition(input);
      await onSaved();
      setBaseline(draft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const validationPreview =
    draft.enabled && draft.exportMode === "required"
      ? i18n.t("admin.documents.metadata-fields.preview.export-required")
      : i18n.t("admin.documents.metadata-fields.preview.default");

  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={definition.label}
        headingLevel={2}
        description={i18n.t(
          "admin.documents.metadata-fields.editor.description",
        )}
      />
      <Stack component="form" onSubmit={save}>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Input
            id="metadata-field-key"
            label={i18n.t("admin.documents.field.key")}
            value={draft.key}
            disabled
            onChange={() => {}}
          />
          <Input
            id="metadata-field-label"
            label={i18n.t("admin.documents.field.label")}
            value={draft.label}
            onChange={(label) => setDraft((old) => ({ ...old, label }))}
            error={fieldError(mutation.error, "label")}
          />
          <Select
            id="metadata-field-required-mode"
            label={i18n.t("admin.documents.field.required-mode")}
            value={draft.requiredMode}
            block
            data={REQUIRED_MODES.map((item) => ({
              value: item,
              label:
                requiredModeLabels[item as keyof typeof requiredModeLabels] ??
                item,
            }))}
            onChange={(requiredMode) =>
              setDraft((old) => ({ ...old, requiredMode }))
            }
            error={fieldError(mutation.error, "requiredMode")}
          />
          <Select
            id="metadata-field-export-mode"
            label={i18n.t("admin.documents.field.export-mode")}
            value={draft.exportMode}
            block
            data={EXPORT_MODES.map((item) => ({
              value: item,
              label:
                exportModeLabels[item as keyof typeof exportModeLabels] ?? item,
            }))}
            onChange={(exportMode) =>
              setDraft((old) => ({ ...old, exportMode }))
            }
            error={fieldError(mutation.error, "exportMode")}
          />
          <Select
            id="metadata-field-editable-by"
            label={i18n.t("admin.documents.field.editable-by")}
            value={draft.editableBy}
            block
            data={EDITABLE_BY.map((item) => ({
              value: item,
              label:
                editableByLabels[item as keyof typeof editableByLabels] ?? item,
            }))}
            onChange={(editableBy) =>
              setDraft((old) => ({ ...old, editableBy }))
            }
            error={fieldError(mutation.error, "editableBy")}
          />
        </SimpleGrid>

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <SettingsSwitchRow
            label={i18n.t("admin.documents.field.enabled")}
            checked={draft.enabled}
            separated
            onChange={(enabled) => setDraft((old) => ({ ...old, enabled }))}
          />
          <SettingsSwitchRow
            label={i18n.t("admin.documents.field.visible-header")}
            checked={draft.visibleInHeader}
            separated
            onChange={(visibleInHeader) =>
              setDraft((old) => ({ ...old, visibleInHeader }))
            }
          />
          <SettingsSwitchRow
            label={i18n.t("admin.documents.field.visible-properties")}
            checked={draft.visibleInProperties}
            separated
            onChange={(visibleInProperties) =>
              setDraft((old) => ({ ...old, visibleInProperties }))
            }
          />
          <SettingsSwitchRow
            label={i18n.t("admin.documents.field.visible-lists")}
            checked={draft.visibleInLists}
            separated
            onChange={(visibleInLists) =>
              setDraft((old) => ({ ...old, visibleInLists }))
            }
          />
        </SimpleGrid>

        <Accordion
          multiple
          value={expanded}
          onChange={(value) => setExpanded(Array.isArray(value) ? value : [])}
        >
          <AccordionItem value="validation">
            <AccordionControl>
              {i18n.t("admin.documents.field.validation-config")}
            </AccordionControl>
            <AccordionPanel>
              <Textarea
                id="metadata-field-validation-config"
                label={i18n.t("admin.documents.field.validation-config")}
                value={draft.validationConfig}
                spellCheck={false}
                onChange={(validationConfig) =>
                  setDraft((old) => ({ ...old, validationConfig }))
                }
                error={
                  jsonError ?? fieldError(mutation.error, "validationConfig")
                }
              />
            </AccordionPanel>
          </AccordionItem>
          <AccordionItem value="metadata">
            <AccordionControl>
              {i18n.t("admin.documents.field.metadata")}
            </AccordionControl>
            <AccordionPanel>
              <Textarea
                id="metadata-field-metadata"
                label={i18n.t("admin.documents.field.metadata")}
                value={draft.metadata}
                spellCheck={false}
                onChange={(metadata) =>
                  setDraft((old) => ({ ...old, metadata }))
                }
                error={jsonError ?? fieldError(mutation.error, "metadata")}
              />
            </AccordionPanel>
          </AccordionItem>
        </Accordion>

        <SettingsNotice tone="neutral">{validationPreview}</SettingsNotice>
        {jsonError || saveError || mutation.error ? (
          <SettingsStatusText role="alert" tone="error">
            {jsonError ?? saveError ?? mutation.error?.message}
          </SettingsStatusText>
        ) : null}
        <SettingsToolbar>
          <Button
            type="button"
            variant="plain"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(clean);
              setBaseline(clean);
              setJsonError(null);
              setSaveError(null);
            }}
          >
            {i18n.t("admin.actions.reset")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || saving}
            data-testid="documents-metadata-field-save"
          >
            {saving
              ? i18n.t("admin.common.saving")
              : i18n.t("admin.common.save")}
          </Button>
        </SettingsToolbar>
      </Stack>
    </Stack>
  );
}

export function MetadataFieldsTab() {
  const i18n = useI18n();
  const query = useDocumentMetadataFieldDefinitionsQuery();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [detailDirty, setDetailDirty] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const selectDefinition = (key: string) => {
    if (detailBusy || key === selected?.key) return;
    if (detailDirty) setPendingKey(key);
    else setSelectedKey(key);
  };

  const definitions = query.definitions;
  const matchingDefinitions = definitions.filter((definition) =>
    `${definition.label} ${definition.key}`
      .toLocaleLowerCase(i18n.language)
      .includes(search.trim().toLocaleLowerCase(i18n.language)),
  );
  const selected =
    definitions.find((item) => item.key === selectedKey) ?? definitions[0];
  useEffect(() => {
    if (!selectedKey && definitions[0]) setSelectedKey(definitions[0].key);
  }, [definitions, selectedKey]);

  if (definitions.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.documents.metadata-fields.empty")}
      />
    );
  }

  return (
    <>
      <SettingsMasterDetailLayout
        detailOpen
        detailPriority="detail"
        detail={
          selected ? (
            <MetadataFieldEditor
              key={selected.key}
              definition={selected}
              onDirtyChange={setDetailDirty}
              onBusyChange={setDetailBusy}
              onSaved={() => query.mutate()}
            />
          ) : (
            <SettingsEmptyState
              title={i18n.t("admin.documents.metadata-fields.select")}
            />
          )
        }
      >
        <Stack component="section">
          <SettingsDetailHeader
            title={i18n.t("admin.documents.metadata-fields.list.title")}
            headingLevel={2}
            description={i18n.t(
              "admin.documents.metadata-fields.list.description",
            )}
          />
          <SettingsCollectionToolbar
            search={
              <Input
                aria-label={i18n.t("admin.common.search")}
                placeholder={i18n.t("admin.common.search")}
                preFix={<SearchIcon aria-hidden />}
                value={search}
                onChange={setSearch}
              />
            }
          />
          {matchingDefinitions.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t("admin.common.no-results-found")}
            />
          ) : null}
          <SurfaceList data-testid="documents-metadata-fields-soft-list">
            {matchingDefinitions.map((definition) => (
              <NavigationLink
                component="button"
                type="button"
                key={definition.key}
                label={definition.label}
                aria-label={definition.label}
                description={definition.key}
                data-testid={`documents-metadata-field-row-${definition.key}`}
                active={selected?.key === definition.key}
                aria-pressed={selected?.key === definition.key}
                rightSection={
                  <Badge tone={definition.enabled ? "success" : "neutral"}>
                    {i18n.t(
                      definition.enabled
                        ? "admin.common.yes"
                        : "admin.common.no",
                    )}
                  </Badge>
                }
                disabled={detailBusy}
                onClick={() => selectDefinition(definition.key)}
              />
            ))}
          </SurfaceList>
        </Stack>
      </SettingsMasterDetailLayout>
      <AdminConfirmModal
        open={pendingKey !== null}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.unsaved.discard-description")}
        confirmText={i18n.t("admin.common.discard-changes")}
        onCancel={() => setPendingKey(null)}
        onConfirm={() => {
          setDetailDirty(false);
          setSelectedKey(pendingKey);
          setPendingKey(null);
        }}
      />
    </>
  );
}
