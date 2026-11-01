// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BpmnEditor,
  BPMN_THEME_ROLES,
  type BpmnEditorRef,
  type BpmnReadiness,
} from "@myoxus/bpmn-editor";
import { useI18n } from "@myoxus/i18n";
import { UndoIcon, RedoIcon } from "@myoxus/icons/react";
import { useLiveData } from "@myoxus/infra";
import {
  Box,
  Button,
  Group,
  HiddenFileInput,
  IconButton,
  IconButtonGroup,
  Menu,
  MenuItem,
  MenuTrigger,
  MyoxusText,
  Modal,
  Notice,
  Radio,
  Stack,
  Text,
  notify,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WORKSPACE_DIALOG_SCHEMA } from "../dialogs/constant";
import type { DialogComponentProps } from "../dialogs/types";
import type { BpmnImportCandidate } from "./session";
import { bpmnSourceErrorText } from "./source-message";

/** The existing workspace portal retains provider/focus ownership; this is never a separate React root. */
export function BpmnEditorDialog({
  session,
  close,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["bpmn-editor"]>) {
  const t = useI18n();
  const state = useLiveData(session.state$);
  const documentTitle = useLiveData(session.documentTitle$);
  const focus = useLiveData(session.focus$);
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<BpmnEditorRef | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const conflictGroupName = useId();
  const [candidate, setCandidate] = useState<{
    file: File;
    value: BpmnImportCandidate;
  } | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [exportingSvg, setExportingSvg] = useState(false);
  const fileGeneration = useRef(0);
  const mergeHeads = useRef<readonly string[] | undefined>(undefined);
  const [conflictReview, setConflictReview] = useState<{
    heads: ReadonlyMap<string, string>;
    selected: string | null;
  } | null>(null);
  // A live list must not silently broaden the user's observed supersession set.
  // Keep captured bytes downloadable and require an explicit review refresh.
  const changedReview =
    conflictReview !== null &&
    (!state.conflict ||
      conflictReview.heads.size !== state.heads.size ||
      [...conflictReview.heads.keys()].some((id) => !state.heads.has(id)));
  const changedImport =
    candidate !== null &&
    candidate.value.conflictHeads.length > 0 &&
    (!state.conflict ||
      candidate.value.conflictHeads.length !== state.heads.size ||
      candidate.value.conflictHeads.some((id) => !state.heads.has(id)));
  const confirmClose = useLiveData(session.closePrompt$);
  const saveAfterConfirmation = useRef(false);
  const [readiness, setReadiness] = useState<BpmnReadiness>({
    status: "ready",
  });
  const attach = useCallback(
    (value: BpmnEditorRef | null) => {
      editor.current = value;
      session.attach(value);
    },
    [session],
  );
  useEffect(() => {
    if (focus) root.current?.focus();
  }, [focus]);
  useEffect(
    () => () => {
      fileGeneration.current++;
    },
    [],
  );
  const run = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      notify.error(
        error instanceof Error && error.message === "BPMN_CONFLICT_CHANGED"
          ? t["com.myoxus.editor.bpmn.conflict-changed"]()
          : t["com.myoxus.common.operation-failed"](),
      );
    }
  };
  const save = async () => {
    await session.save(session.flush());
  };
  const requestClose = () => {
    if (!saveAfterConfirmation.current) close();
  };
  const download = (
    data: string | Uint8Array,
    format: "bpmn" | "svg" = "bpmn",
    candidateRevision?: string,
    revisionKind: "current" | "version" = "current",
  ) => {
    const url = URL.createObjectURL(
      new Blob([typeof data === "string" ? data : data.slice().buffer], {
        type:
          format === "svg"
            ? "image/svg+xml;charset=utf-8"
            : "application/xml;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    const candidateName = candidateRevision
      ? `-${revisionKind}-${candidateRevision.replace(/[^a-zA-Z0-9_-]/g, "_")}`
      : "";
    link.download = `BPMN-${session.request.blockId}${candidateName}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const status = {
    loading: t.Loading(),
    "ready-clean": "",
    "ready-dirty": t["com.myoxus.database.view.unsaved"](),
    "saving-local": t["common.saving"](),
    "awaiting-remote": t["com.myoxus.editor.bpmn.pending-sync"](),
    saved: t["com.myoxus.database.view.saved"](),
    conflict: t["com.myoxus.editor.bpmn.source-conflict"](),
    "source-error": t["com.myoxus.editor.bpmn.source-error"](),
    "save-error": t["com.myoxus.common.operation-failed"](),
    "access-lost": t["com.myoxus.editor.bpmn.access-lost"](),
    deleted: t["com.myoxus.editor.surface-ref.deleted"](),
    fatal: t["com.myoxus.common.operation-failed"](),
  }[state.phase];
  return (
    <Modal
      open
      fullScreen
      keepVisibleInStack
      title={
        <>
          {state.blockTitle || t["com.myoxus.editor.bpmn.default-title"]()}{" "}
          <MyoxusText component="span" tone="secondary">
            ({documentTitle || t.Untitled()})
          </MyoxusText>
        </>
      }
      persistent={state.busy}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      contentOptions={{ "data-testid": "bpmn-editor-dialog" }}
    >
      <Stack h="100%" ref={root} tabIndex={-1}>
        {/* Core owns file/session actions; history calls the retained fork API.
            Titles above are display context and never mutate BPMN XML. */}
        <Group
          role="toolbar"
          aria-label={t["com.myoxus.editor.bpmn.default-title"]()}
        >
          <IconButtonGroup>
            <IconButton
              tooltip={t.Undo()}
              disabled={
                !state.command.canUndo ||
                readiness.status !== "ready" ||
                state.readOnly ||
                state.conflict ||
                state.missing
              }
              onClick={() => editor.current?.undo()}
            >
              <UndoIcon />
            </IconButton>
            <IconButton
              tooltip={t["com.myoxus.editor.keyboard.redo"]()}
              disabled={
                !state.command.canRedo ||
                readiness.status !== "ready" ||
                state.readOnly ||
                state.conflict ||
                state.missing
              }
              onClick={() => editor.current?.redo()}
            >
              <RedoIcon />
            </IconButton>
          </IconButtonGroup>
          <Button
            variant="secondary"
            loading={readingFile}
            disabled={
              state.readOnly ||
              readiness.status === "render-error" ||
              state.missing ||
              state.conflict ||
              state.busy ||
              state.error ||
              state.command.dirty ||
              readingFile
            }
            onClick={() => {
              mergeHeads.current = undefined;
              fileInput.current?.click();
            }}
          >
            {t.Import()}
          </Button>
          <HiddenFileInput
            ref={fileInput}
            accept=".bpmn,.xml,application/xml,text/xml"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              const generation = ++fileGeneration.current;
              const observedHeads = mergeHeads.current;
              mergeHeads.current = undefined;
              setReadingFile(true);
              void run(async () => {
                try {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  if (generation === fileGeneration.current) {
                    setConflictReview(null);
                    setCandidate({
                      file,
                      value: session.prepareImport(bytes, observedHeads),
                    });
                  }
                } finally {
                  if (generation === fileGeneration.current)
                    setReadingFile(false);
                }
              });
            }}
          />
          <Button
            disabled={
              state.readOnly ||
              state.conflict ||
              state.missing ||
              state.busy ||
              !state.source ||
              readiness.status !== "ready"
            }
            loading={state.busy}
            onClick={() => {
              void run(save);
            }}
          >
            {t.Save()}
          </Button>
          <Menu
            items={
              <>
                <MenuItem
                  disabled={
                    !state.source || state.busy || state.error || state.conflict
                  }
                  onSelect={() => {
                    if (state.source) download(state.source.xml);
                  }}
                >
                  {t["com.myoxus.editor.bpmn.export-saved-source"]()}
                </MenuItem>
                <MenuItem
                  disabled={
                    readiness.status !== "ready" ||
                    !state.source ||
                    state.busy ||
                    exportingSvg
                  }
                  title={t[
                    "com.myoxus.editor.bpmn.export-current-description"
                  ]()}
                  onSelect={() => {
                    void run(() => {
                      const snapshot = session.flush();
                      download(snapshot.xml, "bpmn", snapshot.revision);
                    });
                  }}
                >
                  {t["com.myoxus.editor.bpmn.export-current-source"]()}
                </MenuItem>
                <MenuItem
                  disabled={
                    readiness.status !== "ready" ||
                    !state.source ||
                    state.busy ||
                    exportingSvg
                  }
                  title={t[
                    "com.myoxus.editor.bpmn.export-current-description"
                  ]()}
                  onSelect={() => {
                    void run(async () => {
                      if (!editor.current) throw new Error("BPMN_NOT_READY");
                      setExportingSvg(true);
                      try {
                        const value = await session.exportSvg();
                        download(value.svg, "svg", value.revision);
                      } finally {
                        setExportingSvg(false);
                      }
                    });
                  }}
                >
                  {t["com.myoxus.editor.bpmn.export-current-svg"]()}
                </MenuItem>
              </>
            }
          >
            <MenuTrigger>{t.Export()}</MenuTrigger>
          </Menu>
          <Text role="status" aria-live="polite">
            {status}
          </Text>
          {state.syncError && !state.busy && (
            <Button variant="secondary" onClick={() => session.retrySync()}>
              {t.Retry()}
            </Button>
          )}
        </Group>
        {state.error && (
          <Notice tone="error">
            <Group>
              <Text>{t["com.myoxus.common.operation-failed"]()}</Text>
              <Button
                onClick={() => {
                  void run(() => session.retry());
                }}
                disabled={state.busy || state.readOnly || state.missing}
              >
                {t.Retry()}
              </Button>
              <Button
                onClick={() => {
                  const xml = session.flush().xml;
                  download(xml);
                }}
              >
                {t["com.myoxus.attachment.download"]()}
              </Button>
            </Group>
          </Notice>
        )}
        {(state.conflict || state.missing) && (
          <Notice tone="error">
            <Group>
              <Text>
                {state.conflict
                  ? t["com.myoxus.editor.bpmn.source-conflict"]()
                  : t["com.myoxus.editor.surface-ref.deleted"]()}
              </Text>
              {state.conflict && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    setConflictReview({ heads: state.heads, selected: null })
                  }
                >
                  {t["com.myoxus.editor.bpmn.resolve-conflict"]()}
                </Button>
              )}
            </Group>
          </Notice>
        )}
        <Modal
          open={conflictReview !== null}
          title={t["com.myoxus.editor.bpmn.resolve-conflict"]()}
          persistent={state.busy || readingFile}
          onOpenChange={(open) => {
            if (!open && !state.busy && !readingFile) setConflictReview(null);
          }}
        >
          {conflictReview && (
            <Stack>
              <Text>{t["com.myoxus.editor.bpmn.conflict-description"]()}</Text>
              <Stack
                role="radiogroup"
                aria-label={t["com.myoxus.editor.bpmn.resolve-conflict"]()}
              >
                {[...conflictReview.heads]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([id, xml]) => (
                    <Group key={id}>
                      <Radio
                        name={conflictGroupName}
                        label={id}
                        checked={conflictReview.selected === id}
                        disabled={state.busy || changedReview}
                        onChange={() =>
                          setConflictReview({ ...conflictReview, selected: id })
                        }
                      />
                      <Button
                        variant="secondary"
                        onClick={() => download(xml, "bpmn", id, "version")}
                      >
                        {t["com.myoxus.attachment.download"]()}
                      </Button>
                    </Group>
                  ))}
              </Stack>
              {changedReview && (
                <Notice tone="warning">
                  <Stack>
                    <Text>
                      {t["com.myoxus.editor.bpmn.conflict-changed"]()}
                    </Text>
                    {state.conflict && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setConflictReview({
                            heads: state.heads,
                            selected: null,
                          })
                        }
                      >
                        {t["com.myoxus.editor.bpmn.review-versions"]()}
                      </Button>
                    )}
                  </Stack>
                </Notice>
              )}
              {(state.command.dirty || state.error) && (
                <Notice tone="warning">
                  {t["com.myoxus.editor.bpmn.conflict-local-changes"]()}
                </Notice>
              )}
              <Group>
                <Button
                  loading={state.busy}
                  disabled={
                    !conflictReview.selected ||
                    changedReview ||
                    state.readOnly ||
                    state.missing ||
                    state.busy ||
                    state.command.dirty ||
                    state.error
                  }
                  onClick={() => {
                    void run(async () => {
                      if (!conflictReview.selected) return;
                      await session.resolveConflict(
                        [...conflictReview.heads.keys()],
                        { head: conflictReview.selected },
                      );
                      setConflictReview(null);
                    });
                  }}
                >
                  {t["com.myoxus.editor.bpmn.keep-version"]()}
                </Button>
                <Button
                  variant="secondary"
                  loading={readingFile}
                  disabled={
                    changedReview ||
                    state.readOnly ||
                    state.missing ||
                    state.busy ||
                    state.command.dirty ||
                    state.error ||
                    readingFile
                  }
                  onClick={() => {
                    mergeHeads.current = [...conflictReview.heads.keys()];
                    fileInput.current?.click();
                  }}
                >
                  {t["com.myoxus.editor.bpmn.import-merged-source"]()}
                </Button>
                <Button
                  variant="secondary"
                  disabled={state.busy || readingFile}
                  onClick={() => setConflictReview(null)}
                >
                  {t.Cancel()}
                </Button>
              </Group>
            </Stack>
          )}
        </Modal>
        {readiness.status !== "ready" &&
          readiness.status !== "render-error" && (
            <Notice tone="error">
              <Group>
                <Text>{bpmnSourceErrorText(t, readiness.error.code)}</Text>
                <Button
                  onClick={() => {
                    if (state.source) download(state.source.xml);
                  }}
                >
                  {t["com.myoxus.attachment.download"]()}
                </Button>
              </Group>
            </Notice>
          )}
        <Modal
          open={candidate !== null}
          title={t["com.myoxus.editor.bpmn.import-title"]()}
          persistent={state.busy}
          onOpenChange={(open) => {
            if (!open && !state.busy) setCandidate(null);
          }}
        >
          {candidate && (
            <Stack>
              <Text>{candidate.file.name}</Text>
              <Text>
                {candidate.value.conflictHeads.length
                  ? t["com.myoxus.editor.bpmn.conflict-description"]()
                  : t["com.myoxus.editor.bpmn.replace-description"]()}
              </Text>
              {changedImport && (
                <Notice tone="warning">
                  {t["com.myoxus.editor.bpmn.conflict-changed"]()}
                </Notice>
              )}
              {candidate.value.inspection.status !== "accepted" && (
                <Notice tone="error">
                  <Text>
                    {bpmnSourceErrorText(
                      t,
                      candidate.value.inspection.error.code,
                    )}
                  </Text>
                </Notice>
              )}
              {state.error && (
                <Notice tone="error">
                  {t["com.myoxus.common.operation-failed"]()}
                </Notice>
              )}
              <Group>
                <Button
                  disabled={
                    candidate.value.inspection.status !== "accepted" ||
                    (changedImport && !state.error) ||
                    state.readOnly ||
                    state.busy ||
                    state.command.dirty ||
                    (state.conflict && !candidate.value.conflictHeads.length)
                  }
                  loading={state.busy}
                  onClick={() => {
                    void run(async () => {
                      if (state.error) await session.retry();
                      else await session.replaceSource(candidate.value);
                      setCandidate(null);
                    });
                  }}
                >
                  {state.error
                    ? t.Retry()
                    : t["com.myoxus.editor.bpmn.replace-source"]()}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => download(candidate.value.inspection.bytes)}
                >
                  {t["com.myoxus.attachment.download"]()}
                </Button>
                <Button
                  variant="secondary"
                  disabled={state.busy}
                  onClick={() => setCandidate(null)}
                >
                  {t.Cancel()}
                </Button>
              </Group>
            </Stack>
          )}
        </Modal>
        <Modal
          open={confirmClose}
          title={t["com.myoxus.database.view.unsaved"]()}
          onOpenChange={(open) => {
            if (!open) void run(() => session.answerClose("cancel"));
          }}
          onExitTransitionEnd={() => {
            if (!saveAfterConfirmation.current) return;
            saveAfterConfirmation.current = false;
            // The confirmation's native focus trap must be gone before flush
            // may focus a rejected field in the underlying modeller.
            void run(async () => {
              await session.answerClose("save");
            });
          }}
        >
          <Group>
            {state.readOnly || state.missing || readiness.status !== "ready" ? (
              <Button
                disabled={state.busy}
                onClick={() => {
                  void run(() => download(session.flush().xml));
                }}
              >
                {t["com.myoxus.attachment.download"]()}
              </Button>
            ) : (
              <Button
                disabled={state.busy}
                onClick={() => {
                  saveAfterConfirmation.current = true;
                  session.hideClosePrompt();
                }}
              >
                {t.Save()}
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={state.busy}
              onClick={() => {
                void run(() => {
                  return session.answerClose("discard");
                });
              }}
            >
              {t["com.myoxus.database.task-detail.discard-changes"]()}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void run(() => session.answerClose("cancel"));
              }}
            >
              {t.Cancel()}
            </Button>
          </Group>
        </Modal>
        <Box flex={1} mih={0}>
          {state.source ? (
            <BpmnEditor
              ref={attach}
              source={state.source}
              locale={t.language}
              themeRoles={BPMN_THEME_ROLES}
              readOnly={state.readOnly || state.missing || state.conflict}
              onCommandStateChange={(command) => session.report(command)}
              onReadinessChange={(value) => {
                setReadiness(value);
                session.reportReadiness(value);
              }}
              onSourceChange={(snapshot) => {
                // Flush/download may finalize recovery-only drafts after remote
                // deletion. Never turn that export into a new terminal save error.
                if (state.missing) return;
                void run(() => session.save(snapshot));
              }}
              onError={() =>
                notify.error(t["com.myoxus.common.operation-failed"]())
              }
            />
          ) : !state.conflict ? (
            <Text>{t["com.myoxus.editor.bpmn.source-conflict"]()}</Text>
          ) : null}
        </Box>
      </Stack>
    </Modal>
  );
}
