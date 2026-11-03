// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { LiveData, useLiveData } from "@myoxus/infra";
import {
  Button,
  Group,
  MyoxusLoader,
  MyoxusText,
  Notice,
  Stack,
  Text,
  notify,
} from "@myoxus/ui-facade";
import { nanoid } from "nanoid";
import type { RefObject } from "react";
import type { Workspace } from "../workspace";
import { ConversionDiagnostics } from "./conversion-diagnostics";
import {
  DocxExportError,
  runServerDocxExport,
  type DocxExportOptions,
  type DocxExportPhase,
  type DocxExportFailure,
  type DocxExportResult,
} from "./run-server-docx-export";

type ExportState =
  | { phase: DocxExportPhase }
  | { phase: "complete"; result: DocxExportResult }
  | { phase: "error"; reason: DocxExportFailure };
const phaseKeys = {
  sync: "com.myoxus.export.word.syncing",
  prepare: "com.myoxus.export.word.preparing",
  save: "com.myoxus.export.word.saving",
} as const;
const errorKeys = {
  unavailable: "com.myoxus.export.word.unavailable",
  mode: "com.myoxus.export.word.mode",
  permission: "com.myoxus.no-permission",
  sync: "com.myoxus.export.word.sync-failed",
  connection: "com.myoxus.export.word.connection",
  conversion: "com.myoxus.export.word.conversion-failed",
  empty: "com.myoxus.export.word.empty",
  size: "com.myoxus.export.word.size",
  save: "com.myoxus.export.word.save-failed",
  update: "com.myoxus.export.word.update-required",
} as const;

function DocxExportNotification({
  state,
  title,
  workspaceName,
  retry,
  dismiss,
  id,
}: {
  state: LiveData<ExportState>;
  title: string;
  workspaceName: string;
  retry: () => void;
  dismiss: () => void;
  id: string;
}) {
  const current = useLiveData(state);
  const t = useI18n();
  return (
    <Stack
      data-testid="docx-export-status"
      data-docx-export-id={id}
      role="status"
      aria-live="polite"
    >
      <Text>
        {current.phase === "complete" ? current.result.filename : title}
      </Text>
      <MyoxusText tone="secondary">{workspaceName}</MyoxusText>
      {current.phase === "complete" ? (
        <>
          <Notice
            tone={current.result.warnings.length ? "warning" : "success"}
            title={
              current.result.warnings.length
                ? t["com.myoxus.conversion.limited"]()
                : current.result.outcome === "saved"
                  ? t["com.myoxus.export.word.saved"]()
                  : t["com.myoxus.export.word.provided"]()
            }
          >
            {current.result.warnings.length > 0 && (
              <Text>
                {current.result.outcome === "saved"
                  ? t["com.myoxus.export.word.saved"]()
                  : t["com.myoxus.export.word.provided"]()}
              </Text>
            )}
            {current.result.warnings.length > 0 && (
              <ConversionDiagnostics warnings={current.result.warnings} />
            )}
          </Notice>
          <Button variant="primary" onClick={dismiss}>
            {t.Complete()}
          </Button>
        </>
      ) : current.phase === "error" ? (
        <>
          <Notice tone="error" title={t["com.myoxus.export.word.failed"]()}>
            {t[errorKeys[current.reason]]()}
          </Notice>
          {["unavailable", "mode", "permission", "update"].includes(
            current.reason,
          ) ? (
            <Button variant="primary" onClick={dismiss}>
              {t.Complete()}
            </Button>
          ) : (
            <Button variant="primary" onClick={retry}>
              {t.Retry()}
            </Button>
          )}
        </>
      ) : (
        <Group>
          <MyoxusLoader />
          <Text>{t[phaseKeys[current.phase]]()}</Text>
        </Group>
      )}
    </Stack>
  );
}

// Menus can remount while a request runs. Key admission to the workspace and
// document, not a transient menu hook; only active promises are retained.
const active = new WeakMap<Workspace, Map<string, Promise<void>>>();
const notices = new WeakMap<Workspace, Map<string, string>>();
export function startDocxExport(
  options: DocxExportOptions,
  returnFocusRef?: RefObject<HTMLElement | null>,
): Promise<void> {
  let workspace = active.get(options.workspace);
  if (!workspace) {
    workspace = new Map();
    active.set(options.workspace, workspace);
  }
  const requests = workspace;
  const previous = workspace.get(options.page.id);
  if (previous) return previous;
  const id = `docx-export-${nanoid()}`;
  let ownedNotices = notices.get(options.workspace);
  if (!ownedNotices) {
    ownedNotices = new Map();
    notices.set(options.workspace, ownedNotices);
  }
  const currentNotices = ownedNotices;
  const oldNotice = ownedNotices.get(options.page.id);
  ownedNotices.set(options.page.id, id);
  if (oldNotice) notify.dismiss(oldNotice);
  const state = new LiveData<ExportState>({ phase: "sync" });
  const dismiss = () => {
    notify.dismiss(id);
    if (returnFocusRef?.current?.isConnected) returnFocusRef.current.focus();
  };
  notify(
    {
      message: (
        <DocxExportNotification
          id={id}
          state={state}
          title={options.page.meta?.title || "export.docx"}
          workspaceName={options.workspace.name$.value ?? ""}
          dismiss={dismiss}
          retry={() => {
            notify.dismiss(id);
            void startDocxExport(options, returnFocusRef);
          }}
        />
      ),
      onDismiss: () => {
        if (currentNotices.get(options.page.id) === id)
          currentNotices.delete(options.page.id);
        const notification = document
          .querySelector(`[data-docx-export-id="${id}"]`)
          ?.closest('[role="alert"]');
        // Only a user closing the focused result returns to its trigger.
        // Background save cancellation must not steal editor focus.
        if (
          notification?.contains(document.activeElement) &&
          returnFocusRef?.current?.isConnected
        )
          returnFocusRef.current.focus();
      },
    },
    { id, duration: 0 },
  );
  const attempt = (async () => {
    try {
      const result = await runServerDocxExport(options, (phase) =>
        state.next({ phase }),
      );
      if (result.outcome === "cancelled") notify.dismiss(id);
      else state.next({ phase: "complete", result });
    } catch (cause) {
      state.next({
        phase: "error",
        reason: cause instanceof DocxExportError ? cause.reason : "conversion",
      });
    }
  })();
  workspace.set(options.page.id, attempt);
  void attempt.finally(() => {
    if (requests.get(options.page.id) === attempt)
      requests.delete(options.page.id);
  });
  return attempt;
}
