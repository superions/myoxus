import { useI18n } from "@myoxus/i18n";
import { Plus, Save } from "@myoxus/icons/react";
import {
  Button,
  DialogFooterActions,
  Modal,
  NumberInput,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  MyoxusSegmentedControl,
  SettingsDetailHeader,
  SettingsStatusText,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  useDocumentMetadataFieldDefinitionsQuery,
  useDocumentMetadataValueDefinitionsQuery,
  useUpsertDocumentMetadataValueDefinitionMutation,
} from "../api";
import { EmptyState, ErrorText, TextField } from "./shared";

const VALUE_LIST_METADATA_FIELD_KEYS = new Set([
  "classification",
  "audience",
  "retentionPolicy",
  "language",
]);

export function ValueListsTab() {
  const i18n = useI18n();
  const definitionsQuery = useDocumentMetadataFieldDefinitionsQuery();
  const valueListDefinitions = useMemo(
    () =>
      definitionsQuery.definitions.filter((definition) =>
        VALUE_LIST_METADATA_FIELD_KEYS.has(definition.key),
      ),
    [definitionsQuery.definitions],
  );
  const [metadataFieldKey, setMetadataFieldKey] = useState<string | null>(null);
  const selectedKey = metadataFieldKey ?? valueListDefinitions[0]?.key ?? null;
  const valuesQuery = useDocumentMetadataValueDefinitionsQuery(selectedKey);
  const mutation = useUpsertDocumentMetadataValueDefinitionMutation();
  const [editorFieldKey, setEditorFieldKey] = useState<string | null>(null);
  // Keep the dialog mounted through its exit so Mantine can restore trigger focus.
  const [editorOpen, setEditorOpen] = useState(false);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [draftFieldKey, setDraftFieldKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeEditor = () => {
    if (!saving) setEditorOpen(false);
  };
  const openEditor = () => {
    if (!selectedKey) return;
    if (draftFieldKey !== selectedKey)
      setDraft({
        key: "",
        label: "",
        description: "",
        color: "",
        icon: "",
        sortOrder: "0",
      });
    setDraftFieldKey(selectedKey);
    setActionError(null);
    setEditorFieldKey(selectedKey);
    setEditorOpen(true);
  };
  const [draft, setDraft] = useState({
    key: "",
    label: "",
    description: "",
    color: "",
    icon: "",
    sortOrder: "0",
  });

  useEffect(() => {
    if (!metadataFieldKey && valueListDefinitions[0])
      setMetadataFieldKey(valueListDefinitions[0].key);
  }, [metadataFieldKey, valueListDefinitions]);

  async function createValue(event: React.FormEvent) {
    event.preventDefault();
    if (!editorFieldKey) return;
    setSaving(true);
    setActionError(null);
    try {
      await mutation.upsertValue({
        fieldKey: editorFieldKey,
        key: draft.key,
        label: draft.label,
        description: draft.description || null,
        color: draft.color || null,
        icon: draft.icon || null,
        sortOrder: Number(draft.sortOrder) || 0,
        isActive: true,
        metadata: {},
      });
      await valuesQuery.mutate();
      setEditorOpen(false);
      setDraft({
        key: "",
        label: "",
        description: "",
        color: "",
        icon: "",
        sortOrder: "0",
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggleValue(
    value: (typeof valuesQuery.values)[number],
    active: boolean,
  ) {
    setSaving(true);
    setActionError(null);
    try {
      await mutation.upsertValue({
        id: value.id,
        fieldKey: value.fieldKey,
        key: value.key,
        label: value.label,
        description: value.description,
        color: value.color,
        icon: value.icon,
        sortOrder: value.sortOrder,
        isActive: active,
        metadata: value.metadata,
      });
      await valuesQuery.mutate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const selectedDefinition = valueListDefinitions.find(
    (definition) => definition.key === selectedKey,
  );
  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={i18n.t("admin.documents.value-lists.list.title")}
        headingLevel={2}
        actions={
          <Button
            variant="primary"
            prefix={<Plus aria-hidden />}
            disabled={!selectedKey || saving}
            ref={editorTriggerRef}
            onClick={openEditor}
            data-testid="documents-create-value"
          >
            {i18n.t("admin.documents.value-lists.create.title")}
          </Button>
        }
      />
      {valueListDefinitions.length ? (
        <MyoxusSegmentedControl
          value={selectedKey ?? undefined}
          layout="fluid"
          aria-label={i18n.t("admin.documents.value-lists.list.title")}
          disabled={saving}
          data={valueListDefinitions.map((definition) => ({
            value: definition.key,
            label: definition.label,
          }))}
          onChange={setMetadataFieldKey}
        />
      ) : (
        <EmptyState>{i18n.t("admin.documents.value-lists.empty")}</EmptyState>
      )}
      {selectedDefinition ? (
        <SettingsDetailHeader
          title={selectedDefinition.label}
          description={selectedDefinition.key}
          headingLevel={3}
        />
      ) : null}
      {actionError && !editorOpen ? <ErrorText>{actionError}</ErrorText> : null}
      {valuesQuery.values.length ? (
        <Table
          aria-label={selectedDefinition?.label}
          data-testid="documents-value-lists-soft-list"
        >
          <TableHeader>
            <TableRow>
              <TableHead>{i18n.t("admin.documents.field.label")}</TableHead>
              <TableHead>{i18n.t("admin.documents.field.key")}</TableHead>
              <TableHead>
                {i18n.t("admin.documents.field.sort-order")}
              </TableHead>
              <TableHead>{i18n.t("admin.common.active")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...valuesQuery.values]
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((value) => (
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
                    <Switch
                      checked={value.isActive}
                      aria-label={
                        value.label + " · " + i18n.t("admin.common.active")
                      }
                      disabled={saving}
                      onChange={(active) => void toggleValue(value, active)}
                    />
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      ) : selectedKey ? (
        <EmptyState>
          {i18n.t("admin.documents.value-lists.values-empty")}
        </EmptyState>
      ) : null}
      {editorFieldKey ? (
        <Modal
          open={editorOpen}
          returnFocusRef={editorTriggerRef}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          persistent={saving}
          scrollable
          title={i18n.t("admin.documents.value-lists.create.title")}
          description={
            valueListDefinitions.find(
              (definition) => definition.key === editorFieldKey,
            )?.label
          }
          contentOptions={{ "data-testid": "documents-value-editor" }}
        >
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
          <Stack component="form" onSubmit={createValue}>
            <TextField
              id="value-key"
              label={i18n.t("admin.documents.field.key")}
              value={draft.key}
              onChange={(key) => setDraft((old) => ({ ...old, key }))}
            />
            <TextField
              id="value-label"
              label={i18n.t("admin.documents.field.label")}
              value={draft.label}
              onChange={(label) => setDraft((old) => ({ ...old, label }))}
            />
            <TextField
              id="value-description"
              label={i18n.t("admin.documents.field.description")}
              value={draft.description}
              onChange={(description) =>
                setDraft((old) => ({ ...old, description }))
              }
            />
            <TextField
              id="value-color"
              label={i18n.t("admin.documents.field.color")}
              value={draft.color}
              onChange={(color) => setDraft((old) => ({ ...old, color }))}
            />
            <TextField
              id="value-icon"
              label={i18n.t("admin.documents.field.icon")}
              value={draft.icon}
              onChange={(icon) => setDraft((old) => ({ ...old, icon }))}
            />
            <NumberInput
              id="value-sort-order"
              label={i18n.t("admin.documents.field.sort-order")}
              value={draft.sortOrder}
              allowDecimal={false}
              clampBehavior="none"
              onChange={(sortOrder) =>
                setDraft((old) => ({ ...old, sortOrder: String(sortOrder) }))
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
                disabled={!draft.key.trim() || !draft.label.trim() || saving}
              >
                {saving
                  ? i18n.t("admin.common.saving")
                  : i18n.t("admin.common.save")}
              </Button>
            </DialogFooterActions>
          </Stack>
        </Modal>
      ) : null}
    </Stack>
  );
}
