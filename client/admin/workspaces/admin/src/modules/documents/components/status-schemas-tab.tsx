import { useI18n } from "@myoxus/i18n";
import { Plus, ArrowRight, Save } from "@myoxus/icons/react";
import {
  Button,
  Group,
  DialogFooterActions,
  Modal,
  MultiSelect,
  NavigationLink,
  NumberInput,
  SettingsCollectionToolbar,
  SettingsEmptyState,
  Stack,
  Select,
  Switch,
  SettingsStatusText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SettingsDetailHeader,
  SettingsMasterDetailLayout,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  useDocumentMetadataFieldDefinitionsQuery,
  useDocumentStatusSchemasQuery,
  useDocumentStatusValuesQuery,
  useUpsertDocumentStatusSchemaMutation,
  useUpsertDocumentStatusTransitionMutation,
  useUpsertDocumentStatusValueMutation,
} from "../api";
import {
  BooleanField,
  BooleanStatus,
  EmptyState,
  ErrorText,
  SelectField,
  TextField,
} from "./shared";

const SCHEMA_COMPLEXITY = ["simple", "review", "controlled", "custom"];
const CREATES_VERSION = ["never", "optional", "required"];
const VERSION_KINDS = [
  "checkpoint",
  "milestone",
  "published",
  "exported",
  "restored",
];
const DATE_ENFORCEMENT = ["warn", "block_transition", "block_export"];

export function StatusSchemasTab() {
  const i18n = useI18n();
  const okfOptions = [
    { value: "draft", label: i18n.t("admin.templates.badge.draft") },
    { value: "stable", label: i18n.t("admin.documents.status.okf-stable") },
    { value: "deprecated", label: i18n.t("admin.templates.badge.deprecated") },
  ];
  const complexityLabels = {
    simple: i18n.t("admin.documents.status.complexity.simple"),
    review: i18n.t("admin.documents.status.complexity.review"),
    controlled: i18n.t("admin.documents.status.complexity.controlled"),
    custom: i18n.t("admin.documents.custom"),
  };
  const createsVersionLabels = {
    never: i18n.t("admin.documents.required-mode.never"),
    optional: i18n.t("admin.documents.export-mode.optional"),
    required: i18n.t("admin.documents.export-mode.required"),
  };
  const versionKindLabels = {
    checkpoint: i18n.t("admin.documents.version-kind.checkpoint"),
    milestone: i18n.t("admin.documents.version-kind.milestone"),
    published: i18n.t("admin.documents.version-kind.published"),
    exported: i18n.t("admin.documents.version-kind.exported"),
    restored: i18n.t("admin.documents.version-kind.restored"),
  };
  const dateEnforcementLabels = {
    warn: i18n.t("admin.documents.status.date-enforcement.warn"),
    block_transition: i18n.t(
      "admin.documents.status.date-enforcement.block_transition",
    ),
    block_export: i18n.t(
      "admin.documents.status.date-enforcement.block_export",
    ),
  };
  const schemasQuery = useDocumentStatusSchemasQuery();
  const metadataFieldsQuery = useDocumentMetadataFieldDefinitionsQuery();
  const [selectedSchemaKey, setSelectedSchemaKey] = useState<string | null>(
    null,
  );
  const selectedSchema =
    schemasQuery.schemas.find((schema) => schema.key === selectedSchemaKey) ??
    schemasQuery.schemas[0];
  const valuesQuery = useDocumentStatusValuesQuery(selectedSchema?.key ?? null);
  const schemaMutation = useUpsertDocumentStatusSchemaMutation();
  const valueMutation = useUpsertDocumentStatusValueMutation();
  const transitionMutation = useUpsertDocumentStatusTransitionMutation();

  useEffect(() => {
    if (!selectedSchemaKey && schemasQuery.schemas[0]) {
      setSelectedSchemaKey(schemasQuery.schemas[0].key);
    }
  }, [schemasQuery.schemas, selectedSchemaKey]);

  const [editor, setEditor] = useState<
    "schema" | "value" | "transition" | null
  >(null);
  // Keep the dialog mounted through its exit so Mantine can restore trigger focus.
  const [editorOpen, setEditorOpen] = useState(false);
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const [editorSchema, setEditorSchema] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [valueDraftSchemaId, setValueDraftSchemaId] = useState<string | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeEditor = () => {
    if (!saving) setEditorOpen(false);
  };
  const openEditor = (
    next: "schema" | "value" | "transition",
    trigger: HTMLElement,
  ) => {
    editorTriggerRef.current = trigger;
    setActionError(null);
    setEditorSchema(selectedSchema ?? null);
    if (next === "value" && selectedSchema?.id !== valueDraftSchemaId) {
      setStatusValueDraft({
        key: "",
        label: "",
        description: "",
        color: "",
        icon: "",
        sortOrder: "0",
        terminal: false,
        okfStatus: "draft",
      });
      setValueDraftSchemaId(selectedSchema?.id ?? null);
    }
    // Transition defaults belong to the schema selected when its dialog opens.
    if (next === "transition")
      setTransitionDraft({
        fromStatusId: firstStatusId,
        toStatusId: secondStatusId,
        requiredMetadataFields: [],
        requiredRoles: "",
        createsVersion: "never",
        setsVersionKind: "checkpoint",
        dateEnforcement: "warn",
      });
    setEditor(next);
    setEditorOpen(true);
  };

  const [schemaDraft, setSchemaDraft] = useState({
    key: "",
    label: "",
    description: "",
    complexity: "simple",
  });
  const [statusValueDraft, setStatusValueDraft] = useState({
    key: "",
    label: "",
    description: "",
    color: "",
    icon: "",
    sortOrder: "0",
    terminal: false,
    okfStatus: "draft",
  });
  const [transitionDraft, setTransitionDraft] = useState({
    fromStatusId: "",
    toStatusId: "",
    requiredMetadataFields: [] as string[],
    requiredRoles: "",
    createsVersion: "never",
    setsVersionKind: "checkpoint",
    dateEnforcement: "warn",
  });

  const sortedValues = useMemo(
    () => [...valuesQuery.values].sort((a, b) => a.sortOrder - b.sortOrder),
    [valuesQuery.values],
  );
  const firstStatusId = sortedValues[0]?.id ?? "";
  const secondStatusId = sortedValues[1]?.id ?? firstStatusId;

  async function createSchema(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      await schemaMutation.upsertSchema({
        key: schemaDraft.key,
        label: schemaDraft.label,
        description: schemaDraft.description || null,
        complexity: schemaDraft.complexity,
        isPreset: false,
        isActive: true,
        metadata: {},
      });
      await schemasQuery.mutate();
      setSelectedSchemaKey(schemaDraft.key);
      setEditorOpen(false);
      setSchemaDraft({
        key: "",
        label: "",
        description: "",
        complexity: "simple",
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatusValue(
    value: (typeof sortedValues)[number],
    active: boolean,
    okfStatus = value.okfStatus,
  ) {
    setSaving(true);
    setActionError(null);
    try {
      await valueMutation.upsertStatusValue({
        id: value.id,
        schemaId: value.schemaId,
        key: value.key,
        label: value.label,
        description: value.description,
        color: value.color,
        icon: value.icon,
        sortOrder: value.sortOrder,
        terminal: value.terminal,
        isActive: active,
        okfStatus,
        metadata: value.metadata,
      });
      await valuesQuery.mutate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function createStatusValue(event: React.FormEvent) {
    event.preventDefault();
    if (!editorSchema) return;
    setSaving(true);
    setActionError(null);
    try {
      await valueMutation.upsertStatusValue({
        schemaId: editorSchema.id,
        key: statusValueDraft.key,
        label: statusValueDraft.label,
        description: statusValueDraft.description || null,
        color: statusValueDraft.color || null,
        icon: statusValueDraft.icon || null,
        sortOrder: Number(statusValueDraft.sortOrder) || 0,
        terminal: statusValueDraft.terminal,
        okfStatus: statusValueDraft.okfStatus,
        isActive: true,
        metadata: {},
      });
      await valuesQuery.mutate();
      setEditorOpen(false);
      setStatusValueDraft({
        key: "",
        label: "",
        description: "",
        color: "",
        icon: "",
        sortOrder: "0",
        terminal: false,
        okfStatus: "draft",
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveTransition(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setActionError(null);
    try {
      await transitionMutation.upsertTransition({
        fromStatusId: transitionDraft.fromStatusId,
        toStatusId: transitionDraft.toStatusId,
        requiredMetadataFields: transitionDraft.requiredMetadataFields,
        requiredRoles: transitionDraft.requiredRoles
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        createsVersion: transitionDraft.createsVersion,
        setsVersionKind:
          transitionDraft.createsVersion === "never"
            ? null
            : transitionDraft.setsVersionKind,
        dateEnforcement: transitionDraft.dateEnforcement,
        metadata: {},
      });
      setEditorOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack>
      <SettingsCollectionToolbar
        search={null}
        actions={
          <Button
            variant="primary"
            prefix={<Plus aria-hidden />}
            onClick={(event) => openEditor("schema", event.currentTarget)}
            data-testid="documents-create-schema"
          >
            {i18n.t("admin.documents.status.create-schema.title")}
          </Button>
        }
      />
      {actionError && !editorOpen ? <ErrorText>{actionError}</ErrorText> : null}
      <SettingsMasterDetailLayout
        detailOpen={Boolean(selectedSchema)}
        detailPriority="detail"
        detail={
          selectedSchema ? (
            <Stack component="section" data-testid="documents-status-detail">
              <SettingsDetailHeader
                title={selectedSchema.label}
                description={selectedSchema.description}
                headingLevel={2}
                actions={<BooleanStatus value={selectedSchema.isActive} />}
              />
              <SettingsCollectionToolbar
                search={null}
                actions={
                  <Group>
                    <Button
                      prefix={<ArrowRight aria-hidden />}
                      disabled={!sortedValues.length || saving}
                      onClick={(event) =>
                        openEditor("transition", event.currentTarget)
                      }
                      data-testid="documents-configure-transition"
                    >
                      {i18n.t("admin.documents.status.transition.title")}
                    </Button>
                    <Button
                      variant="primary"
                      prefix={<Plus aria-hidden />}
                      disabled={saving}
                      onClick={(event) =>
                        openEditor("value", event.currentTarget)
                      }
                      data-testid="documents-create-status-value"
                    >
                      {i18n.t("admin.documents.status.create-value.title")}
                    </Button>
                  </Group>
                }
              />
              {sortedValues.length ? (
                <Table
                  aria-label={i18n.t("admin.documents.status.values.title")}
                  data-testid="documents-status-values-soft-list"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {i18n.t("admin.documents.field.label")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.documents.field.key")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.documents.field.sort-order")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.documents.field.terminal")}
                      </TableHead>
                      <TableHead>
                        {i18n.t("admin.documents.status.okf-mapping")}
                      </TableHead>
                      <TableHead>{i18n.t("admin.common.active")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedValues.map((value) => (
                      <TableRow key={value.id}>
                        <TableCell>
                          {value.label}
                          {value.description ? (
                            <SettingsStatusText>
                              {value.description}
                            </SettingsStatusText>
                          ) : null}
                        </TableCell>
                        <TableCell>{value.key}</TableCell>
                        <TableCell>{value.sortOrder}</TableCell>
                        <TableCell>
                          <BooleanStatus value={value.terminal} />
                        </TableCell>
                        <TableCell>
                          <Select
                            aria-label={
                              value.label +
                              " · " +
                              i18n.t("admin.documents.status.okf-mapping")
                            }
                            value={value.okfStatus}
                            data={okfOptions}
                            disabled={saving}
                            onChange={(mapping) =>
                              void toggleStatusValue(
                                value,
                                value.isActive,
                                mapping,
                              )
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={value.isActive}
                            aria-label={
                              value.label +
                              " · " +
                              i18n.t("admin.common.active")
                            }
                            disabled={saving}
                            onChange={(active) =>
                              void toggleStatusValue(value, active)
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <SettingsEmptyState
                  title={i18n.t("admin.common.no-results-found")}
                />
              )}
            </Stack>
          ) : null
        }
      >
        <Stack component="section">
          <SettingsDetailHeader
            title={i18n.t("admin.documents.status.schemas.title")}
            headingLevel={2}
          />
          {schemasQuery.schemas.length ? (
            schemasQuery.schemas.map((schema) => (
              <NavigationLink
                component="button"
                type="button"
                key={schema.id}
                label={schema.label}
                aria-label={schema.label}
                description={
                  schema.key +
                  (schema.key === schema.complexity
                    ? ""
                    : " · " + schema.complexity) +
                  " · " +
                  (schema.isPreset
                    ? i18n.t("admin.documents.preset")
                    : i18n.t("admin.documents.custom"))
                }
                active={selectedSchema?.id === schema.id}
                aria-pressed={selectedSchema?.id === schema.id}
                disabled={saving}
                rightSection={<BooleanStatus value={schema.isActive} />}
                onClick={() => setSelectedSchemaKey(schema.key)}
              />
            ))
          ) : (
            <EmptyState>{i18n.t("admin.documents.status.empty")}</EmptyState>
          )}
        </Stack>
      </SettingsMasterDetailLayout>
      {editor ? (
        <Modal
          open={editorOpen}
          returnFocusRef={editorTriggerRef}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          persistent={saving}
          scrollable
          title={
            editor === "schema"
              ? i18n.t("admin.documents.status.create-schema.title")
              : editor === "value"
                ? i18n.t("admin.documents.status.create-value.title")
                : i18n.t("admin.documents.status.transition.title")
          }
          description={editor === "schema" ? undefined : editorSchema?.label}
          contentOptions={{ "data-testid": "documents-status-editor" }}
        >
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
          {editor === "schema" ? (
            <Stack component="form" onSubmit={createSchema}>
              <TextField
                id="schema-key"
                label={i18n.t("admin.documents.field.key")}
                value={schemaDraft.key}
                onChange={(key) => setSchemaDraft((old) => ({ ...old, key }))}
              />
              <TextField
                id="schema-label"
                label={i18n.t("admin.documents.field.label")}
                value={schemaDraft.label}
                onChange={(label) =>
                  setSchemaDraft((old) => ({ ...old, label }))
                }
              />
              <TextField
                id="schema-description"
                label={i18n.t("admin.documents.field.description")}
                value={schemaDraft.description}
                onChange={(description) =>
                  setSchemaDraft((old) => ({ ...old, description }))
                }
              />
              <SelectField
                id="schema-complexity"
                label={i18n.t("admin.documents.field.complexity")}
                value={schemaDraft.complexity}
                values={SCHEMA_COMPLEXITY}
                optionLabels={complexityLabels}
                onChange={(complexity) =>
                  setSchemaDraft((old) => ({ ...old, complexity }))
                }
              />
              <DialogFooterActions>
                <Button
                  type="button"
                  variant="plain"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  {i18n.t("admin.common.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  prefix={<Save aria-hidden />}
                  disabled={
                    saving ||
                    !schemaDraft.key.trim() ||
                    !schemaDraft.label.trim()
                  }
                >
                  {saving
                    ? i18n.t("admin.common.saving")
                    : i18n.t("admin.common.save")}
                </Button>
              </DialogFooterActions>
            </Stack>
          ) : editor === "value" ? (
            <Stack component="form" onSubmit={createStatusValue}>
              <TextField
                id="status-value-key"
                label={i18n.t("admin.documents.field.key")}
                value={statusValueDraft.key}
                onChange={(key) =>
                  setStatusValueDraft((old) => ({ ...old, key }))
                }
              />
              <TextField
                id="status-value-label"
                label={i18n.t("admin.documents.field.label")}
                value={statusValueDraft.label}
                onChange={(label) =>
                  setStatusValueDraft((old) => ({ ...old, label }))
                }
              />
              <TextField
                id="status-value-description"
                label={i18n.t("admin.documents.field.description")}
                value={statusValueDraft.description}
                onChange={(description) =>
                  setStatusValueDraft((old) => ({ ...old, description }))
                }
              />
              <TextField
                id="status-value-color"
                label={i18n.t("admin.documents.field.color")}
                value={statusValueDraft.color}
                onChange={(color) =>
                  setStatusValueDraft((old) => ({ ...old, color }))
                }
              />
              <TextField
                id="status-value-icon"
                label={i18n.t("admin.documents.field.icon")}
                value={statusValueDraft.icon}
                onChange={(icon) =>
                  setStatusValueDraft((old) => ({ ...old, icon }))
                }
              />
              <NumberInput
                id="status-value-sort-order"
                label={i18n.t("admin.documents.field.sort-order")}
                value={statusValueDraft.sortOrder}
                allowDecimal={false}
                clampBehavior="none"
                onChange={(sortOrder) =>
                  setStatusValueDraft((old) => ({
                    ...old,
                    sortOrder: String(sortOrder),
                  }))
                }
              />
              <Select
                label={i18n.t("admin.documents.status.okf-mapping")}
                value={statusValueDraft.okfStatus}
                data={okfOptions}
                disabled={saving}
                onChange={(okfStatus) =>
                  setStatusValueDraft((old) => ({ ...old, okfStatus }))
                }
              />
              <BooleanField
                label={i18n.t("admin.documents.field.terminal")}
                checked={statusValueDraft.terminal}
                onCheckedChange={(terminal) =>
                  setStatusValueDraft((old) => ({ ...old, terminal }))
                }
              />
              <DialogFooterActions>
                <Button
                  type="button"
                  variant="plain"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  {i18n.t("admin.common.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  prefix={<Save aria-hidden />}
                  disabled={
                    saving ||
                    !selectedSchema ||
                    !statusValueDraft.key.trim() ||
                    !statusValueDraft.label.trim()
                  }
                >
                  {saving
                    ? i18n.t("admin.common.saving")
                    : i18n.t("admin.common.save")}
                </Button>
              </DialogFooterActions>
            </Stack>
          ) : (
            <Stack component="form" onSubmit={saveTransition}>
              <SelectField
                id="transition-from"
                label={i18n.t("admin.documents.field.from-status")}
                value={transitionDraft.fromStatusId}
                values={sortedValues.map((value) => value.id)}
                optionLabels={Object.fromEntries(
                  sortedValues.map((value) => [value.id, value.label]),
                )}
                onChange={(fromStatusId) =>
                  setTransitionDraft((old) => ({ ...old, fromStatusId }))
                }
              />
              <SelectField
                id="transition-to"
                label={i18n.t("admin.documents.field.to-status")}
                value={transitionDraft.toStatusId}
                values={sortedValues.map((value) => value.id)}
                optionLabels={Object.fromEntries(
                  sortedValues.map((value) => [value.id, value.label]),
                )}
                onChange={(toStatusId) =>
                  setTransitionDraft((old) => ({ ...old, toStatusId }))
                }
              />
              <MultiSelect
                block
                label={i18n.t("admin.documents.field.required-metadata-fields")}
                data={metadataFieldsQuery.definitions.map((field) => ({
                  value: field.key,
                  label: field.label,
                }))}
                searchable
                clearable
                value={transitionDraft.requiredMetadataFields}
                onChange={(requiredMetadataFields) =>
                  setTransitionDraft((old) => ({
                    ...old,
                    requiredMetadataFields,
                  }))
                }
              />
              <TextField
                id="transition-roles"
                label={i18n.t("admin.documents.field.required-roles")}
                value={transitionDraft.requiredRoles}
                onChange={(requiredRoles) =>
                  setTransitionDraft((old) => ({ ...old, requiredRoles }))
                }
                placeholder="role-a, role-b"
              />
              <SelectField
                id="transition-creates-version"
                label={i18n.t("admin.documents.field.creates-version")}
                value={transitionDraft.createsVersion}
                values={CREATES_VERSION}
                optionLabels={createsVersionLabels}
                onChange={(createsVersion) =>
                  setTransitionDraft((old) => ({ ...old, createsVersion }))
                }
              />
              {transitionDraft.createsVersion !== "never" ? (
                <SelectField
                  id="transition-version-kind"
                  label={i18n.t("admin.documents.field.version-kind")}
                  value={transitionDraft.setsVersionKind}
                  values={VERSION_KINDS}
                  optionLabels={versionKindLabels}
                  onChange={(setsVersionKind) =>
                    setTransitionDraft((old) => ({ ...old, setsVersionKind }))
                  }
                />
              ) : null}
              <SelectField
                id="transition-date-enforcement"
                label={i18n.t("admin.documents.field.date-enforcement")}
                value={transitionDraft.dateEnforcement}
                values={DATE_ENFORCEMENT}
                optionLabels={dateEnforcementLabels}
                onChange={(dateEnforcement) =>
                  setTransitionDraft((old) => ({ ...old, dateEnforcement }))
                }
              />
              <DialogFooterActions>
                <Button
                  type="button"
                  variant="plain"
                  disabled={saving}
                  onClick={closeEditor}
                >
                  {i18n.t("admin.common.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  prefix={<Save aria-hidden />}
                  disabled={
                    saving ||
                    !sortedValues.some(
                      (value) => value.id === transitionDraft.fromStatusId,
                    ) ||
                    !sortedValues.some(
                      (value) => value.id === transitionDraft.toStatusId,
                    )
                  }
                >
                  {saving
                    ? i18n.t("admin.common.saving")
                    : i18n.t("admin.common.save")}
                </Button>
              </DialogFooterActions>
            </Stack>
          )}
        </Modal>
      ) : null}
    </Stack>
  );
}
