import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
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
import { openFilesWith } from "@virgultum/editor/shared/utils";
import { useCallback, useEffect } from "react";

import { useNavigateHelper } from "../../../components/hooks/use-navigate-helper";
import { WorkbenchService } from "../../../modules/workbench/services/workbench";
import {
  DocsService,
  type DocxImportAttempt,
} from "../../../modules/doc/services/docs";
import { ConversionDiagnostics } from "../../../modules/file-export/conversion-diagnostics";

const errorKeys = {
  format: "com.myoxus.import.word.format",
  empty: "com.myoxus.import.word.empty",
  size: "com.myoxus.import.word.size",
  permission: "com.myoxus.import.word.permission",
  unavailable: "com.myoxus.import.word.unavailable",
  conversion: "com.myoxus.import.word.conversion",
  unknown: "com.myoxus.import.word.unknown",
} as const;

export function DocxImportStatus({
  attempt,
  onOpen,
  onInspect,
  onSelect,
}: {
  attempt: DocxImportAttempt;
  onOpen: () => void;
  onInspect: () => void;
  onSelect?: () => void;
}) {
  const t = useI18n();
  const pending =
    attempt.status === "selecting" || attempt.status === "importing";
  return (
    <Stack data-testid="docx-import-result" role="status" aria-live="polite">
      <Text title={attempt.filename}>
        {attempt.status === "complete"
          ? attempt.title
          : (attempt.filename ?? t["com.myoxus.import.docx"]())}
      </Text>
      <MyoxusText tone="secondary">{attempt.workspaceName}</MyoxusText>
      {pending ? (
        <>
          <Group>
            <MyoxusLoader />
            <Text>{t["com.myoxus.import.status.importing.title"]()}</Text>
          </Group>
          <Text>
            {attempt.status === "selecting"
              ? t["com.myoxus.import.word.selecting"]()
              : t["com.myoxus.import.word.pending"]()}
          </Text>
        </>
      ) : attempt.status === "complete" ? (
        <>
          <Notice
            tone={attempt.warnings.length ? "warning" : "success"}
            title={
              attempt.warnings.length
                ? t["com.myoxus.conversion.limited"]()
                : t["com.myoxus.import.status.success.title"]()
            }
          >
            <ConversionDiagnostics warnings={attempt.warnings} bestEffort />
          </Notice>
          {!attempt.ready && !attempt.detached && (
            <Text>{t["com.myoxus.import.word.sync"]()}</Text>
          )}
          <Button
            variant="primary"
            onClick={attempt.ready || attempt.detached ? onOpen : onInspect}
          >
            {attempt.ready || attempt.detached
              ? t["com.myoxus.database.document_link.open"]()
              : t["All content"]()}
          </Button>
        </>
      ) : attempt.status === "error" ? (
        <>
          <Notice
            tone={attempt.reason === "unknown" ? "warning" : "error"}
            title={
              attempt.reason === "unknown"
                ? t["com.myoxus.import.word.unknown-title"]()
                : t["com.myoxus.import.status.failed.title"]()
            }
          >
            {t[errorKeys[attempt.reason]]()}
          </Notice>
          {attempt.reason === "unknown" || !onSelect ? (
            <Button variant="primary" onClick={onInspect}>
              {t["All content"]()}
            </Button>
          ) : (
            <Button variant="primary" onClick={onSelect}>
              {t["com.myoxus.workspace-import.choose-file"]()}
            </Button>
          )}
        </>
      ) : null}
    </Stack>
  );
}

function ImportNotification({
  docs,
  onOpen,
  onInspect,
  id,
  attemptId,
}: {
  docs: DocsService;
  onOpen: (attempt: Extract<DocxImportAttempt, { status: "complete" }>) => void;
  onInspect: (workspace: string) => void;
  id: string;
  attemptId: string;
}) {
  const attempt = useLiveData(docs.docxImport$);
  useEffect(() => {
    if (!attempt || attempt.attemptId !== attemptId) notify.dismiss(id);
  }, [attempt, attemptId, id]);
  if (!attempt || attempt.attemptId !== attemptId) return null;
  return (
    <DocxImportStatus
      attempt={attempt}
      onOpen={() => {
        if (attempt.status === "complete") onOpen(attempt);
      }}
      onInspect={() => onInspect(attempt.workspaceId)}
    />
  );
}

const notifications = new WeakMap<DocsService, string>();

export function showDocxImportNotification(
  docs: DocsService,
  navigate: (workspace: string, document: string) => void,
) {
  const attempt = docs.docxImport$.value;
  if (!attempt) return;
  const id = `docx-import-${attempt.attemptId}`;
  const previous = notifications.get(docs);
  notifications.set(docs, id);
  if (previous && previous !== id) notify.dismiss(previous);
  notify(
    {
      message: (
        <ImportNotification
          docs={docs}
          id={id}
          attemptId={attempt.attemptId}
          onOpen={(result) => navigate(result.workspaceId, result.id)}
          onInspect={(workspace) => navigate(workspace, "all")}
        />
      ),
      onDismiss: () => {
        if (notifications.get(docs) === id) notifications.delete(docs);
        docs.dismissDocxImportResult(attempt.attemptId);
      },
    },
    { id, duration: 0 },
  );
}

export function useOwnedDocxImport({
  onComplete,
  presentation,
}: {
  onComplete?: (result: {
    docIds: string[];
    docx: Extract<DocxImportAttempt, { status: "complete" }>;
  }) => void;
  presentation: "dialog" | "notification";
}) {
  const docs = useService(DocsService);
  const { jumpToPage } = useNavigateHelper();
  const workbench = useService(WorkbenchService).workbench;
  return useCallback(async () => {
    const state = docs.docxImport$.value;
    if (
      state?.status === "selecting" ||
      state?.status === "importing" ||
      (state?.status === "error" && state.reason === "unknown")
    ) {
      if (presentation === "notification")
        showDocxImportNotification(docs, jumpToPage);
      return;
    }
    const originView = workbench.activeView$.value;
    const originPath = workbench.location$.value.pathname;
    const request = docs.importDocx(
      async () => (await openFilesWith("Docx", false))?.[0],
      originPath,
    );
    if (presentation === "notification")
      showDocxImportNotification(docs, jumpToPage);
    const result = await request;
    // An old menu closure must not navigate the user away from a later document
    // or reinterpret completion in a different workspace. Its notice retains Open.
    if (
      presentation === "notification" &&
      result?.status === "complete" &&
      result.ready &&
      !result.detached &&
      workbench.activeView$.value === originView &&
      workbench.location$.value.pathname === result.origin
    ) {
      onComplete?.({ docIds: [result.id], docx: result });
    }
  }, [docs, jumpToPage, presentation, onComplete, workbench]);
}
