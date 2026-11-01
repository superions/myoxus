// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  InlineContentTrigger,
  Modal,
  type MyoxusRichTextDocument,
  MyoxusText,
  Notice,
  RichTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

const EMPTY_DOCUMENT: MyoxusRichTextDocument = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export type DatabaseRichTextValue = {
  document?: MyoxusRichTextDocument | null;
  plainText?: string | null;
} | null;

export interface DatabaseRichTextCellHandle {
  /** Discard only this editor's draft when conflict resolution reloads state. */
  discardDraft(): void;
  /** Close a compact editor after a successful forced conflict overwrite. */
  finishEdit(): void;
  /** Save through the native mutation owner; conflicts and failures retain the draft. */
  saveDraft(): Promise<boolean>;
}

export function DatabaseRichTextCell({
  autoFocus = false,
  expanded = false,
  inline = false,
  handleRef,
  fieldName,
  onEditEnd,
  onEditStart,
  onDraftStateChange,
  onSave,
  readOnly = false,
  value,
}: {
  autoFocus?: boolean;
  expanded?: boolean;
  inline?: boolean;
  handleRef?: Ref<DatabaseRichTextCellHandle>;
  fieldName: string;
  onEditEnd?: () => void;
  onEditStart?: () => void;
  onDraftStateChange?: (state: { dirty: boolean; pending: boolean }) => void;
  onSave?: (document: MyoxusRichTextDocument) => Promise<boolean | void>;
  readOnly?: boolean;
  value: DatabaseRichTextValue;
}) {
  const t = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreInlineFocusRef = useRef(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const persisted = useMemo(
    () => value?.document ?? EMPTY_DOCUMENT,
    [value?.document],
  );
  const [draft, setDraft] = useState<MyoxusRichTextDocument>(persisted);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Imperative Apply and browser events share one flight before React commits.
  const savingRef = useRef(false);
  const [error, setError] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(persisted);

  useEffect(() => {
    if (!dirty) setDraft(persisted);
  }, [dirty, persisted]);

  useEffect(() => {
    if (!error) return;
    // Validation inserts the Notice after a potentially long editor. Keep the
    // owning Mantine scroll container native while ensuring recovery actions
    // cannot be pushed just beyond its visible edge.
    actionsRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);

  useEffect(() => {
    if (open || !restoreInlineFocusRef.current) return;
    restoreInlineFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  const save = async (): Promise<boolean> => {
    if (!onSave || readOnly || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(false);
    try {
      const saved = await onSave(draft);
      // The shared conflict controller returns `false` while the explicit
      // reload/overwrite decision is pending. Keep this editor and its local
      // draft mounted so conflict resolution cannot silently discard work.
      if (saved !== false) {
        onEditEnd?.();
        setOpen(false);
        if (inline) restoreInlineFocusRef.current = true;
        return true;
      }
      return false;
    } catch {
      setError(true);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  useImperativeHandle(handleRef, () => ({
    saveDraft: save,
    discardDraft() {
      if (savingRef.current) return;
      setDraft(persisted);
      setError(false);
      setOpen(false);
      onEditEnd?.();
    },
    finishEdit() {
      setError(false);
      setOpen(false);
      onEditEnd?.();
    },
  }));

  useEffect(() => {
    onDraftStateChange?.({ dirty, pending: saving });
  }, [dirty, saving, onDraftStateChange]);

  const cancel = () => {
    if (savingRef.current) return;
    setDraft(persisted);
    setError(false);
    setOpen(false);
    onEditEnd?.();
    if (inline) restoreInlineFocusRef.current = true;
  };
  const editor = (
    <Stack gap="xs">
      <RichTextInput
        aria-label={fieldName}
        autoFocus={autoFocus}
        value={draft}
        onChange={setDraft}
        onFocus={onEditStart}
        readOnly={readOnly || saving}
        labels={{
          boldControlLabel: t["com.myoxus.database.rich-text.bold"](),
          italicControlLabel: t["com.myoxus.database.rich-text.italic"](),
          strikeControlLabel: t["com.myoxus.database.rich-text.strike"](),
          codeControlLabel: t["com.myoxus.database.rich-text.code"](),
          linkControlLabel: t["com.myoxus.database.rich-text.link"](),
          unlinkControlLabel: t["com.myoxus.database.rich-text.unlink"](),
          undoControlLabel: t["com.myoxus.database.rich-text.undo"](),
          redoControlLabel: t["com.myoxus.database.rich-text.redo"](),
          linkEditorInputLabel: t["com.myoxus.database.rich-text.link-url"](),
          linkEditorInputPlaceholder: "https://example.com/",
          linkEditorSave: t["Save"](),
        }}
      />
      {error ? (
        <Notice
          tone="error"
          title={t["com.myoxus.database.rich-text.save-error"]()}
        />
      ) : null}
      {!readOnly ? (
        <Group ref={actionsRef} justify="flex-end">
          <Button variant="secondary" disabled={saving} onClick={cancel}>
            {t["Cancel"]()}
          </Button>
          <Button
            loading={saving}
            disabled={!dirty}
            onClick={() => void save()}
          >
            {t["Save"]()}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );

  if (readOnly) {
    return (
      <MyoxusText
        preserveWhitespace={expanded}
        lineClamp={expanded ? undefined : 2}
        tone={value?.plainText ? "primary" : "secondary"}
      >
        {value?.plainText || t["com.myoxus.database.cell.empty"]()}
      </MyoxusText>
    );
  }

  if (expanded || (inline && open)) {
    return (
      <Stack
        gap="xs"
        data-testid={inline ? "database-rich-text-inline-editor" : undefined}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey)
          ) {
            event.preventDefault();
            void save();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {editor}
      </Stack>
    );
  }

  const trigger = (
    <InlineContentTrigger
      ref={triggerRef}
      onClick={(event) => {
        event.stopPropagation();
        onEditStart?.();
        setOpen(true);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "F2") {
          event.preventDefault();
          onEditStart?.();
          setOpen(true);
        }
      }}
      data-testid="database-rich-text-open"
    >
      <MyoxusText
        lineClamp={2}
        tone={value?.plainText ? "primary" : "secondary"}
      >
        {value?.plainText || t["com.myoxus.database.cell.empty"]()}
      </MyoxusText>
    </InlineContentTrigger>
  );

  if (inline) return trigger;

  return (
    <>
      {trigger}
      <Modal
        stackId="database-rich-text"
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : cancel())}
        scrollable
        title={fieldName}
        returnFocusRef={triggerRef}
        contentOptions={{ "data-testid": "database-rich-text-dialog" }}
      >
        {editor}
      </Modal>
    </>
  );
}
