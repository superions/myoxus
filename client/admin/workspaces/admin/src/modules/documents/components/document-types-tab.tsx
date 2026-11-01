import { useI18n } from "@myoxus/i18n";
import { Plus, Save } from "@myoxus/icons/react";
import {
  Button,
  DialogFooterActions,
  Loading,
  Modal,
  SettingsDetailHeader,
  SettingsStatusText,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import { useRef, useState } from "react";

import { useDocumentTypesQuery, useUpsertDocumentTypeMutation } from "../api";
import { BooleanStatus, EmptyState, ErrorText, TextField } from "./shared";

const emptyDraft = { key: "", label: "", description: "", icon: "", color: "" };

export function DocumentTypesTab() {
  const i18n = useI18n();
  const typesQuery = useDocumentTypesQuery();
  const mutation = useUpsertDocumentTypeMutation();
  const [draft, setDraft] = useState(emptyDraft);
  const [editorOpen, setEditorOpen] = useState(false);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = saving || mutation.isMutating;

  async function createType(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || !draft.key.trim() || !draft.label.trim()) return;
    busyRef.current = true;
    setSaving(true);
    setActionError(null);
    try {
      await mutation.upsertType({
        key: draft.key,
        label: draft.label,
        description: draft.description || null,
        icon: draft.icon || null,
        color: draft.color || null,
        isActive: true,
        isSuggested: true,
      });
      await typesQuery.mutate();
      setEditorOpen(false);
      setDraft(emptyDraft);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  async function toggleType(
    type: (typeof typesQuery.types)[number],
    active: boolean,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    setActionError(null);
    try {
      await mutation.upsertType({
        id: type.id,
        key: type.key,
        label: type.label,
        description: type.description,
        icon: type.icon,
        color: type.color,
        isActive: active,
        isSuggested: type.isSuggested,
      });
      await typesQuery.mutate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={i18n.t("admin.documents.types.list.title")}
        headingLevel={2}
        description={i18n.t("admin.documents.types.list.description")}
        actions={
          <Button
            variant="primary"
            prefix={<Plus aria-hidden />}
            ref={editorTriggerRef}
            disabled={busy}
            data-testid="documents-create-type"
            onClick={() => {
              setActionError(null);
              setEditorOpen(true);
            }}
          >
            {i18n.t("admin.documents.types.create.title")}
          </Button>
        }
      />
      {actionError && !editorOpen ? <ErrorText>{actionError}</ErrorText> : null}
      {typesQuery.error ? (
        <ErrorText>{typesQuery.error.message}</ErrorText>
      ) : null}
      {typesQuery.isLoading ? (
        <Loading />
      ) : typesQuery.types.length ? (
        <Table
          aria-label={i18n.t("admin.documents.types.list.title")}
          data-testid="documents-types-soft-list"
        >
          <TableHeader>
            <TableRow>
              <TableHead>{i18n.t("admin.documents.field.label")}</TableHead>
              <TableHead>{i18n.t("admin.documents.field.key")}</TableHead>
              <TableHead>{i18n.t("admin.documents.field.suggested")}</TableHead>
              <TableHead>{i18n.t("admin.documents.field.active")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {typesQuery.types.map((type) => (
              <TableRow key={type.id}>
                <TableCell>
                  {type.label}
                  {type.description ? (
                    <SettingsStatusText>{type.description}</SettingsStatusText>
                  ) : null}
                </TableCell>
                <TableCell>{type.key}</TableCell>
                <TableCell>
                  <BooleanStatus value={type.isSuggested} />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={type.isActive}
                    disabled={busy}
                    aria-label={
                      type.label +
                      " · " +
                      i18n.t("admin.documents.deactivate-not-delete")
                    }
                    onChange={(active) => void toggleType(type, active)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : !typesQuery.error ? (
        <EmptyState>{i18n.t("admin.documents.types.empty")}</EmptyState>
      ) : null}
      <Modal
        open={editorOpen}
        onOpenChange={(open) => {
          if (!busyRef.current) setEditorOpen(open);
        }}
        returnFocusRef={editorTriggerRef}
        title={i18n.t("admin.documents.types.create.title")}
        closeButtonOptions={{
          "aria-label": i18n.t("admin.common.close"),
          disabled: busy,
        }}
        persistent={busy}
      >
        <Stack component="form" onSubmit={createType}>
          <TextField
            id="type-key"
            label={i18n.t("admin.documents.field.key")}
            value={draft.key}
            disabled={busy}
            onChange={(key) => setDraft((old) => ({ ...old, key }))}
          />
          <TextField
            id="type-label"
            label={i18n.t("admin.documents.field.label")}
            value={draft.label}
            disabled={busy}
            onChange={(label) => setDraft((old) => ({ ...old, label }))}
          />
          <TextField
            id="type-description"
            label={i18n.t("admin.documents.field.description")}
            value={draft.description}
            disabled={busy}
            onChange={(description) =>
              setDraft((old) => ({ ...old, description }))
            }
          />
          <TextField
            id="type-icon"
            label={i18n.t("admin.documents.field.icon")}
            value={draft.icon}
            disabled={busy}
            onChange={(icon) => setDraft((old) => ({ ...old, icon }))}
          />
          <TextField
            id="type-color"
            label={i18n.t("admin.documents.field.color")}
            value={draft.color}
            disabled={busy}
            onChange={(color) => setDraft((old) => ({ ...old, color }))}
          />
          {actionError ? <ErrorText>{actionError}</ErrorText> : null}
          <DialogFooterActions>
            <Button
              type="button"
              variant="plain"
              disabled={busy}
              onClick={() => setEditorOpen(false)}
            >
              {i18n.t("admin.common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              prefix={<Save aria-hidden />}
              disabled={!draft.key.trim() || !draft.label.trim() || busy}
            >
              {busy
                ? i18n.t("admin.common.saving")
                : i18n.t("admin.common.save")}
            </Button>
          </DialogFooterActions>
        </Stack>
      </Modal>
    </Stack>
  );
}
