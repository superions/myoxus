// SPDX-License-Identifier: AGPL-3.0-or-later

import { createOperationUuid } from "../../../utils/uuid";
import type { Server } from "@myoxus/core/modules/server/entities/server";
import {
  createDatabaseTaskFromSourceMutation,
  databaseTaskCaptureReceiptQuery,
  type CreateDatabaseTaskFromSourceInput,
  type DatabaseTaskCaptureResultFragment,
  type DatabaseCellValueInput,
} from "@myoxus/graphql";
import { useEffect, useRef, useState } from "react";
import { classifyDatabaseError } from "../route-state";

/** Capture freezes the reviewed description in the native initial RichText Cell;
 * receipt replay retains these exact bytes rather than copying the source again.
 */
export type TaskCaptureCell = {
  fieldId: string;
  value: Pick<DatabaseCellValueInput, "richText">;
};
type CaptureInput = Omit<CreateDatabaseTaskFromSourceInput, "cells"> & {
  cells: TaskCaptureCell[];
};
type Input = Omit<CaptureInput, "workspaceId" | "requestId">;
type RetainedCapture = {
  input: CaptureInput;
  excerpt: string;
  phase: "pending" | "uncertain" | "confirmed";
  result: DatabaseTaskCaptureResultFragment | null;
  busy: boolean;
};
// A dismissed editor dialog must not turn a lost response into a fresh capture.
// Keep at most one unresolved request for each scoped actor/source document, and never evict it
// to admit other work. Completed/rejected captures are released explicitly.
const retained = new Map<string, RetainedCapture>();
const MAX_RETAINED_CAPTURES = 16;
const drafts = new Map<string, { input: Input; excerpt: string }>();

/** Readback and replay are deliberate actions. The identity includes server,
 * account and workspace; source identity stays in the frozen admitted payload.
 */
export function useCaptureTask(
  server: Server,
  workspaceId: string,
  identity: string,
  sourceDocumentId: string,
  excerpt: string,
  onConfirmed?: () => void,
) {
  const scope = JSON.stringify([identity, sourceDocumentId]);
  const session = useRef(retained.get(scope));
  const draft = useRef(drafts.get(scope));
  const [phase, setPhase] = useState<
    "draft" | "pending" | "uncertain" | "confirmed"
  >(
    session.current
      ? session.current.phase === "pending"
        ? "uncertain"
        : session.current.phase
      : "draft",
  );
  const [result, setResult] = useState(session.current?.result ?? null);
  const [checking, setChecking] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const [failure, setFailure] = useState<
    "invalid" | "forbidden" | "conflict" | "preparation" | null
  >(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const owner = session.current;
      if (
        owner &&
        retained.get(scope) === owner &&
        owner.phase === "confirmed"
      ) {
        owner.result = null;
        owner.phase = "uncertain";
      }
    };
  }, [scope]);
  const notifiedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!result || notifiedRequest.current === result.requestId) return;
    notifiedRequest.current = result.requestId;
    // The live source callback belongs to this mounted dialog, not the retained
    // request. A reopened confirmed receipt may refresh its current source scope.
    onConfirmed?.();
  }, [result, onConfirmed]);
  const confirm = (
    receipt: DatabaseTaskCaptureResultFragment | null | undefined,
  ) => {
    const owner = session.current;
    if (
      !owner ||
      !receipt ||
      receipt.requestId !== owner.input.requestId ||
      (owner.result && receipt.rowId !== owner.result.rowId)
    )
      return false;
    if (!alive.current) {
      owner.result = null;
      owner.phase = "uncertain";
      return true;
    }
    owner.result = receipt;
    owner.phase = "confirmed";
    if (alive.current) {
      setResult(receipt);
      setPhase("confirmed");
    }
    return true;
  };
  const send = async () => {
    const owner = session.current;
    if (!owner || owner.busy || owner.result) return;
    owner.busy = true;
    owner.phase = "pending";
    setPhase("pending");
    setFailure(null);
    try {
      const response = await server.gql({
        query: createDatabaseTaskFromSourceMutation,
        variables: { input: owner.input },
      });
      if (!confirm(response.createDatabaseTaskFromSource)) {
        owner.phase = "uncertain";
        if (alive.current) setPhase("uncertain");
      }
    } catch (error) {
      owner.phase = "uncertain";
      const code = (error as { extensions?: { code?: unknown } })?.extensions
        ?.code;
      if (typeof code === "string" && code.startsWith("MIX_DATABASE_")) {
        if (code === "MIX_DATABASE_TASK_CAPTURE_REQUEST_CONFLICT") {
          if (alive.current) setFailure("conflict");
        } else {
          try {
            const readback = await server.gql({
              query: databaseTaskCaptureReceiptQuery,
              variables: { workspaceId, requestId: owner.input.requestId },
            });
            const receipt = readback.workspace?.databaseTaskCaptureReceipt;
            if (receipt) confirm(receipt);
            else if (readback.workspace && receipt === null) {
              // A typed rejection alone is insufficient: projection can fail
              // after commit. Only successful absent readback releases admission.
              if (retained.get(scope) === owner) retained.delete(scope);
              session.current = undefined;
              if (alive.current) {
                setFailure(
                  code === "MIX_DATABASE_FORBIDDEN" ? "forbidden" : "invalid",
                );
                setPhase("draft");
              }
              return;
            }
          } catch {
            /* Failed readback keeps the original admission uncertain. */
          }
        }
      }
      if (alive.current && !owner.result) setPhase("uncertain");
    } finally {
      owner.busy = false;
    }
  };
  const submit = (input: Input, previewExcerpt = excerpt) => {
    if (session.current) return;
    if (retained.size >= MAX_RETAINED_CAPTURES) {
      setFailure("invalid");
      return;
    }
    let prepared: RetainedCapture;
    try {
      prepared = {
        input: structuredClone({
          ...input,
          workspaceId,
          requestId: createOperationUuid(),
        }),
        excerpt: previewExcerpt,
        phase: "pending",
        result: null,
        busy: false,
      };
    } catch {
      // Local preparation has not admitted a request or consumed its draft.
      setFailure("preparation");
      return;
    }
    session.current = prepared;
    retained.set(scope, session.current);
    drafts.delete(scope);
    return send();
  };
  const review = async () => {
    const owner = session.current;
    if (!owner || owner.busy) return;
    owner.busy = true;
    setChecking(true);
    setReviewFailed(false);
    try {
      const response = await server.gql({
        query: databaseTaskCaptureReceiptQuery,
        variables: { workspaceId, requestId: owner.input.requestId },
      });
      if (
        !confirm(response.workspace?.databaseTaskCaptureReceipt) &&
        alive.current
      )
        setReviewFailed(true);
    } catch (error) {
      if (["forbidden", "missing"].includes(classifyDatabaseError(error))) {
        owner.result = null;
        owner.phase = "uncertain";
        if (alive.current) {
          setResult(null);
          setPhase("uncertain");
        }
      }
      if (alive.current) setReviewFailed(true);
    } finally {
      owner.busy = false;
      if (alive.current) setChecking(false);
    }
  };
  const preserveDraft = (input: Input, previewExcerpt = excerpt) => {
    if (
      session.current ||
      (!drafts.has(scope) && drafts.size >= MAX_RETAINED_CAPTURES)
    ) {
      setFailure("invalid");
      return false;
    }
    drafts.set(scope, {
      input: structuredClone(input),
      excerpt: previewExcerpt,
    });
    return true;
  };
  const retainForReferenceRecovery = () => {
    if (!session.current?.result) return;
    // A reopened recovery performs current authorized receipt readback before
    // showing private target metadata or resuming the same insertion identity.
    session.current.result = null;
    session.current.phase = "uncertain";
  };
  const release = () => {
    if (session.current?.phase !== "confirmed") return;
    if (retained.get(scope) === session.current) retained.delete(scope);
  };
  return {
    phase,
    result,
    checking,
    reviewFailed,
    failure,
    submit,
    review,
    replay: send,
    release,
    retained: session.current,
    draft: draft.current,
    preserveDraft,
    retainForReferenceRecovery,
  };
}
