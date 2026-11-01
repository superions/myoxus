// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { DocPeekPreview } from "@myoxus/core/modules/peek-view/view/doc-preview";
import {
  attachDatabaseRowContentDocumentMutation,
  createDatabaseRowContentDocumentMutation,
  DatabaseRowContentDocumentState,
  detachDatabaseRowContentDocumentMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  FileTextIcon,
  LinkIcon,
  OpenInNewIcon,
  UnlinkIcon,
} from "@myoxus/icons/react";
import {
  Button,
  EmptyState,
  Group,
  Loading,
  MyoxusText,
  MyoxusTitle,
  Stack,
} from "@myoxus/ui-facade";
import { focusBlockEnd } from "@virgultum/editor/shared/commands";
import { getLastNoteBlock } from "@virgultum/editor/shared/utils";
import { useCallback, useRef, useState } from "react";

import { DatabaseDocumentPicker } from "../document-picker";
import { useDatabaseConflictController } from "../presence";
import { executeNonForceableRevisionMutation } from "../presence/execute-revision-mutation";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRowRecord } from "../types";

type ContentAction = "attach" | "create" | "detach" | null;

export function useDatabaseRowContentController({
  canEdit,
  databaseId,
  onChanged,
  onOpenDoc,
  row,
  workspaceId,
}: {
  canEdit: boolean;
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  onOpenDoc: (docId: string) => void;
  row: DatabaseRowRecord;
  workspaceId: string;
}) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const createDocument = useMutation({
    mutation: createDatabaseRowContentDocumentMutation,
  });
  const attachDocument = useMutation({
    mutation: attachDatabaseRowContentDocumentMutation,
  });
  const detachDocument = useMutation({
    mutation: detachDatabaseRowContentDocumentMutation,
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const refreshRow = useCallback(
    () => onChanged({ kind: "row_updated", target: { rowId: row.row.id } }),
    [onChanged, row.row.id],
  );
  const [pending, setPending] = useState<ContentAction>(null);
  const focusAfterCreate = useRef(false);
  const contentDocument = row.row.contentDocument;

  const focusCreatedDocumentBody = useCallback(
    (editor: MyoxusEditorContainer) => {
      if (!focusAfterCreate.current) return;
      focusAfterCreate.current = false;

      // Editor-ready is the first point at which the server-created leaf and
      // its block views are both attached. Use Virgultum's selection command
      // instead of querying implementation-specific contenteditable elements.
      const raf = window.requestAnimationFrame(() => {
        const note = getLastNoteBlock(editor.page);
        const lastBlock = note?.lastChild();
        const focusBlock = lastBlock
          ? (editor.std.view.getBlock(lastBlock.id) ?? undefined)
          : undefined;
        editor.std.command.exec(focusBlockEnd, {
          focusBlock,
          force: true,
        });
      });
      return () => window.cancelAnimationFrame(raf);
    },
    [],
  );

  const createPageContent = async () => {
    if (pending || contentDocument) return;
    setPending("create");
    focusAfterCreate.current = true;
    try {
      const created = await executeNonForceableRevisionMutation(
        conflicts,
        createDocument.trigger,
        {
          databaseId,
          rowId: row.row.id,
          expectedEditRevision: row.row.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.row_content.create"](),
          localValue: row.row.title,
          reloadLatest: () => onChanged(),
          afterSuccess: refreshRow,
        },
      );
      if (created === undefined) {
        focusAfterCreate.current = false;
        return;
      }
    } catch (error) {
      focusAfterCreate.current = false;
      throw error;
    } finally {
      setPending(null);
    }
  };

  const attachPageContent = async (documentId: string) => {
    if (pending) return;
    setPending("attach");
    try {
      await executeNonForceableRevisionMutation(
        conflicts,
        attachDocument.trigger,
        {
          databaseId,
          rowId: row.row.id,
          documentId,
          expectedEditRevision: row.row.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.row_content.attach"](),
          localValue: documentId,
          reloadLatest: () => onChanged(),
          afterSuccess: refreshRow,
        },
      );
    } finally {
      setPending(null);
    }
  };

  const detachPageContent = async () => {
    if (pending || !contentDocument) return;
    setPending("detach");
    try {
      await executeNonForceableRevisionMutation(
        conflicts,
        detachDocument.trigger,
        {
          databaseId,
          rowId: row.row.id,
          expectedEditRevision: row.row.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.row_content.detach"](),
          localValue: contentDocument.documentId,
          reloadLatest: () => onChanged(),
          afterSuccess: refreshRow,
        },
      );
    } finally {
      setPending(null);
    }
  };

  return {
    attachPageContent,
    canEdit,
    contentDocument,
    createPageContent,
    detachPageContent,
    focusCreatedDocumentBody,
    onOpenDoc,
    pending,
    pickerOpen,
    setPickerOpen,
    workspaceId,
  };
}

export type DatabaseRowContentController = ReturnType<
  typeof useDatabaseRowContentController
>;

export function DatabaseRowContent({
  controller,
  showOpenCommand = true,
  compact = false,
}: {
  controller: DatabaseRowContentController;
  showOpenCommand?: boolean;
  compact?: boolean;
}) {
  const {
    attachPageContent,
    canEdit,
    contentDocument,
    createPageContent,
    detachPageContent,
    focusCreatedDocumentBody,
    onOpenDoc,
    pending,
    pickerOpen,
    setPickerOpen,
    workspaceId,
  } = controller;
  const t = useI18n();
  const availableDocumentId =
    contentDocument?.state === DatabaseRowContentDocumentState.Available
      ? contentDocument.externalId
      : null;

  if (compact) {
    if (!contentDocument) return null;
    return availableDocumentId ? (
      <Button
        variant="link"
        prefix={<FileTextIcon />}
        onClick={() => onOpenDoc(availableDocumentId)}
        data-testid="database-row-content-open"
        title={contentDocument.title ?? undefined}
        aria-label={
          contentDocument.title
            ? `${t["com.myoxus.database.row_content.title"]()} · ${contentDocument.title}`
            : t["com.myoxus.database.row_content.title"]()
        }
      >
        {t["com.myoxus.database.row_content.title"]()}
      </Button>
    ) : (
      <MyoxusText tone="secondary">
        {contentDocument.state === DatabaseRowContentDocumentState.Redacted
          ? t["com.myoxus.database.row_content.redacted-title"]()
          : t["com.myoxus.database.row_content.unavailable-title"]()}
      </MyoxusText>
    );
  }

  return (
    <Stack gap="sm" data-testid="database-row-content">
      <Group justify="space-between" align="center" wrap="wrap">
        <MyoxusTitle order={3} typographySlot="section-title">
          {t["com.myoxus.database.row_content.title"]()}
        </MyoxusTitle>
        {availableDocumentId ? (
          <Group gap="xs" wrap="wrap">
            {showOpenCommand ? (
              <Button
                variant="ghost"
                size="sm"
                prefix={<OpenInNewIcon />}
                onClick={() => onOpenDoc(availableDocumentId)}
                data-testid="database-row-content-open"
              >
                {t["com.myoxus.database.row_content.open-full"]()}
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                prefix={<UnlinkIcon />}
                loading={pending === "detach"}
                disabled={Boolean(pending)}
                onClick={detachPageContent}
                data-testid="database-row-content-detach"
              >
                {t["com.myoxus.database.row_content.detach"]()}
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Group>

      {pending === "create" ? (
        <Stack align="center" data-testid="database-row-content-progress">
          <Loading />
          <MyoxusText tone="secondary">
            {t["com.myoxus.database.row_content.creating"]()}
          </MyoxusText>
        </Stack>
      ) : !contentDocument ? (
        <EmptyState
          title={t["com.myoxus.database.row_content.empty-title"]()}
          description={t["com.myoxus.database.row_content.empty-description"]()}
          cta={
            canEdit ? (
              <Group wrap="wrap">
                <Button
                  prefix={<FileTextIcon />}
                  disabled={Boolean(pending)}
                  onClick={() => void createPageContent()}
                  data-testid="database-row-content-create"
                >
                  {t["com.myoxus.database.row_content.create"]()}
                </Button>
                <Button
                  variant="secondary"
                  prefix={<LinkIcon />}
                  disabled={Boolean(pending)}
                  onClick={() => setPickerOpen(true)}
                  data-testid="database-row-content-attach"
                >
                  {t["com.myoxus.database.row_content.attach"]()}
                </Button>
              </Group>
            ) : undefined
          }
        />
      ) : availableDocumentId ? (
        <DocPeekPreview
          docRef={{ docId: availableDocumentId }}
          onEditorReady={focusCreatedDocumentBody}
        />
      ) : contentDocument.state === DatabaseRowContentDocumentState.Redacted ? (
        <EmptyState
          title={t["com.myoxus.database.row_content.redacted-title"]()}
          description={t[
            "com.myoxus.database.row_content.redacted-description"
          ]()}
          data-testid="database-row-content-redacted"
        />
      ) : (
        <EmptyState
          title={t["com.myoxus.database.row_content.unavailable-title"]()}
          description={
            contentDocument.state === DatabaseRowContentDocumentState.Deleted
              ? t["com.myoxus.database.row_content.deleted-description"]()
              : t["com.myoxus.database.row_content.missing-description"]()
          }
          cta={
            canEdit ? (
              <Button
                variant="secondary"
                prefix={<UnlinkIcon />}
                loading={pending === "detach"}
                disabled={Boolean(pending)}
                onClick={detachPageContent}
                data-testid="database-row-content-detach-unavailable"
              >
                {t["com.myoxus.database.row_content.detach"]()}
              </Button>
            ) : undefined
          }
          data-testid={`database-row-content-${contentDocument.state.toLowerCase()}`}
        />
      )}

      <DatabaseDocumentPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        workspaceId={workspaceId}
        currentDocumentId={contentDocument?.documentId ?? null}
        onSelect={(document) => attachPageContent(document.id)}
      />
    </Stack>
  );
}
