// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GraphQLService } from "@myoxus/core/modules/server";
import { createOperationUuid } from "@myoxus/core/utils/uuid";
import type { CaptureDocumentHistoryMutation } from "@myoxus/graphql";
import type { ModalProps } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useEffect, useRef, useState } from "react";

import { captureDocumentHistoryMutation } from "./types";
import { DocumentVersionNameModal } from "./version-name-modal";

type CapturedHistory = CaptureDocumentHistoryMutation["captureDocumentHistory"];

/** Owns the single manual-capture command used by every history entry point. */
export function DocumentHistoryCaptureDialog({
  open,
  workspaceId,
  docId,
  graphqlService,
  beforeCapture,
  onOpenChange,
  onCaptured,
  returnFocusRef,
}: {
  returnFocusRef?: ModalProps["returnFocusRef"];
  open: boolean;
  workspaceId: string;
  docId: string;
  graphqlService: GraphQLService;
  beforeCapture: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onCaptured: (captured: CapturedHistory) => Promise<void> | void;
}) {
  const t = useI18n();
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captureInFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setRequestKey(createOperationUuid());
    setError(null);
  }, [open]);

  const close = () => {
    if (busy) return;
    setRequestKey(null);
    setError(null);
    onOpenChange(false);
  };

  const capture = async (name: string, description: string | null) => {
    if (captureInFlight.current || !requestKey) return;
    captureInFlight.current = true;
    setBusy(true);
    setError(null);
    let captured: CapturedHistory | null = null;
    let failureMessage =
      t["com.myoxus.sidebar.document-versions.error.create-failed"]();
    let captureStarted = false;
    try {
      await beforeCapture();
      captureStarted = true;
      const data = await graphqlService.gql({
        query: captureDocumentHistoryMutation,
        variables: {
          workspaceId,
          docId,
          requestKey,
          name: name.trim() || null,
          description: name.trim() ? description : null,
        },
      });
      if (!data.captureDocumentHistory) {
        failureMessage =
          t["com.myoxus.sidebar.document-versions.error.no-created-version"]();
        throw new Error("captureDocumentHistory returned no version");
      }

      captured = data.captureDocumentHistory;
      console.info("document state saved", {
        docId,
        historyId: captured.historyId,
        versionId: captured.version?.id ?? null,
      });
      onOpenChange(false);
      setRequestKey(null);
    } catch (cause) {
      console.warn("document state save failed", { docId, error: cause });
      setError(
        !captureStarted && cause instanceof Error
          ? cause.message
          : failureMessage,
      );
    } finally {
      captureInFlight.current = false;
      setBusy(false);
    }
    if (captured) {
      // The write is already committed. Follow-up refresh failures belong to
      // the history surface and must never reopen an invitation to recapture.
      await onCaptured(captured);
    }
  };

  return (
    <DocumentVersionNameModal
      returnFocusRef={returnFocusRef}
      allowUnnamed
      busy={busy}
      error={error}
      onClose={close}
      onSubmit={(name, description) => void capture(name, description)}
      open={open}
      stackId="history-capture"
      title={t["com.myoxus.sidebar.document-versions.modal.save-title"]()}
      testId="document-version-modal-create"
    />
  );
}
