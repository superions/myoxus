// SPDX-License-Identifier: AGPL-3.0-or-later

import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { indexerSearchDocsQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  EmptyState,
  Group,
  Input,
  Loading,
  Modal,
  MyoxusText,
  SelectableCardRow,
  Stack,
  SurfaceList,
} from "@myoxus/ui-facade";
import { useEffect, useRef, useState } from "react";

import type { DatabaseActivityEntryLike } from "./row-activity";

export type DocumentPickerDocument = {
  /** Server-internal UUID used by Database mutations. */
  id: string;
  /** Workspace-local key used by editor routes. */
  externalId: string;
  title: string;
};

export type DatabaseDocumentPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  currentDocumentId: string | null;
  onSelect: (document: DocumentPickerDocument) => Promise<unknown> | unknown;
  onClear?: () => Promise<unknown> | unknown;
};

/**
 * Permission filtering belongs to the server search contract. The picker never
 * receives a route-local document cache, so Row Content and DocumentLink cells
 * cannot accidentally expose stale or inaccessible workspace documents.
 */
export function DatabaseDocumentPicker({
  open,
  onOpenChange,
  workspaceId,
  currentDocumentId,
  onSelect,
  onClear,
}: DatabaseDocumentPickerProps) {
  const t = useI18n();
  const graphql = useService(GraphQLService);
  const graphqlRef = useRef(graphql);
  graphqlRef.current = graphql;
  const requestId = useRef(0);
  const [search, setSearch] = useState("");
  const [documents, setDocuments] = useState<DocumentPickerDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [alreadyLinkedDocId, setAlreadyLinkedDocId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setFailed(false);
    const timer = window.setTimeout(() => {
      Promise.resolve(
        graphqlRef.current.gql({
          query: indexerSearchDocsQuery,
          variables: {
            id: workspaceId,
            input: {
              keyword: search.trim(),
              limit: 50,
              useSemanticSearch: false,
            },
          },
        }),
      )
        .then((response) => {
          if (requestId.current !== currentRequestId) return;
          setDocuments(
            (response.workspace?.searchDocs ?? []).map((document) => ({
              id: document.docId,
              externalId: document.externalId,
              title: document.title,
            })),
          );
        })
        .catch(() => {
          if (requestId.current !== currentRequestId) return;
          setDocuments([]);
          setFailed(true);
        })
        .finally(() => {
          if (requestId.current === currentRequestId) setLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, search, workspaceId]);

  useEffect(() => {
    if (!open) {
      requestId.current += 1;
      setSearch("");
      setAlreadyLinkedDocId(null);
    }
  }, [open]);

  const handleSelect = async (document: DocumentPickerDocument) => {
    if (document.id === currentDocumentId) {
      setAlreadyLinkedDocId(document.id);
      return;
    }
    setSubmitting(document.id);
    try {
      await onSelect(document);
      onOpenChange(false);
    } finally {
      setSubmitting(null);
    }
  };

  const handleClear = async () => {
    if (!onClear) return;
    setSubmitting("__clear__");
    try {
      await onClear();
      onOpenChange(false);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.database.document_link.picker-title"]()}
      width="lg"
      contentOptions={{ "data-testid": "database-document-picker" }}
    >
      <Stack>
        <Input
          placeholder={t[
            "com.myoxus.database.document_link.picker-placeholder"
          ]()}
          value={search}
          onChange={setSearch}
          data-testid="database-document-picker-search"
        />
        {loading ? (
          <Loading />
        ) : failed ? (
          <EmptyState
            title={t["com.myoxus.database.document_link.picker-unavailable"]()}
            data-testid="database-document-picker-error"
          />
        ) : documents.length === 0 ? (
          <EmptyState
            title={t["com.myoxus.database.document_link.picker-empty"]()}
            data-testid="database-document-picker-empty"
          />
        ) : (
          <SurfaceList
            label={t["com.myoxus.database.document_link.picker-title"]()}
            data-testid="database-document-picker-list"
          >
            {documents.map((document) => (
              <SelectableCardRow
                key={document.id}
                type="button"
                appearance="row"
                density="compact"
                onClick={() => handleSelect(document)}
                disabled={Boolean(submitting)}
                selected={document.id === currentDocumentId}
                data-testid={`database-document-picker-select-${document.externalId}`}
              >
                <MyoxusText>
                  {document.title ||
                    t["com.myoxus.database.document_link.empty"]()}
                </MyoxusText>
              </SelectableCardRow>
            ))}
          </SurfaceList>
        )}
        {alreadyLinkedDocId ? (
          <Badge
            tone="warning"
            data-testid="database-document-picker-already-linked"
          >
            {t["com.myoxus.database.document_link.already-linked"]()}
          </Badge>
        ) : null}
        <Group justify="space-between" wrap="wrap">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="database-document-picker-cancel"
          >
            {t["com.myoxus.database.document_link.cancel"]()}
          </Button>
          {onClear ? (
            <Button
              variant="destructive"
              onClick={handleClear}
              loading={submitting === "__clear__"}
              disabled={!currentDocumentId}
              data-testid="database-document-picker-clear"
            >
              {t["com.myoxus.database.document_link.action.clear"]()}
            </Button>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}

export type DatabaseDocumentPickerFor = DatabaseActivityEntryLike;
