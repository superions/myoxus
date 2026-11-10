// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatDocumentInput,
  normalizeDocumentField,
} from "@myoxus/core/modules/template-doc/services/template-inputs";
import { useDocumentFieldPresentation } from "@myoxus/core/editor/virgultum/doc-editor/document-field-presentation";
import { documentFieldLabels } from "@myoxus/core/editor/virgultum/doc-editor/document-field-labels";
import { DocumentFieldDefinition } from "@myoxus/core/editor/virgultum/doc-editor/document-field-definition";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormSelect,
  Group,
  Input,
  InlineActionButton,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Modal,
  MultiSelect,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  DocumentFieldReactHostIdentifier,
  type DocumentFieldInlineHostProps,
} from "@virgultum/editor/shared/services";
import {
  DOCUMENT_FIELD_MAX_OPTIONS,
  DocumentFieldSchema,
  initializeDocumentField,
  type DocumentField,
} from "@virgultum/editor/shared/types";
import type { ExtensionType } from "@virgultum/editor/store";
import { useEffect, useRef, useState } from "react";

/** Register one visual host; the surrounding editor owns its shared context. */
export function patchDocumentFieldHost(reactToLit: ReactToLit): ExtensionType {
  return {
    setup: (di) =>
      di.addImpl(DocumentFieldReactHostIdentifier, () => ({
        renderInline: (props: DocumentFieldInlineHostProps) =>
          reactToLit(<DocumentFieldInline {...props} />, true),
      })),
  };
}

export function DocumentFieldInline({
  field,
  readonly,
  textProtected = false,
  convertToText,
  updateDefinition,
  updateValue,
  focusEditor,
}: DocumentFieldInlineHostProps) {
  const t = useI18n();
  const context = useDocumentFieldPresentation();
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Extract<
    DocumentField,
    { type: "input" }
  > | null>(null);
  const [definitionOpen, setDefinitionOpen] = useState(false);
  const [definitionStale, setDefinitionStale] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [selectionDraft, setSelectionDraft] = useState<string[]>([]);
  const [valueError, setValueError] = useState<"invalid" | "stale" | null>(
    null,
  );
  const expectedValue = useRef<DocumentField | null>(null);
  const pendingValue = useRef<{
    expected: DocumentField;
    replacement: DocumentField;
  } | null>(null);
  const pendingCancel = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pendingMetadata = useRef(false);
  const pendingDefinition = useRef<{
    expected: DocumentField;
    replacement: DocumentField;
  } | null>(null);
  const pendingReplacement = useRef<{
    expected: DocumentField;
    text: string;
  } | null>(null);
  useEffect(() => {
    if (readonly || textProtected || context?.template !== true)
      setDefinitionOpen(false);
  }, [readonly, textProtected, context?.template]);
  useEffect(() => {
    if (readonly && field.type === "input") setOpened(false);
  }, [readonly, field.type]);
  const labels = documentFieldLabels(t);
  const label =
    field.type === "input" ? field.definition.label : labels[field.key];
  let text = "—";
  let description = t["com.myoxus.editor.field.unavailable"]({ label });
  let state = "unavailable";

  if (field.type === "input" && context) {
    if (context.template === null && !textProtected) {
      return (
        <span
          aria-label={`${label}: ${t["Loading"]()}`}
          data-document-field-id={field.id}
          data-document-field-state="pending"
        >
          {label}
        </span>
      );
    }
    try {
      const input =
        context.template && !textProtected
          ? initializeDocumentField(field)
          : field;
      const value = formatDocumentInput(input, context.preferences);
      const shown = value.text === "" ? null : value.text;
      text = shown ?? label;
      description =
        shown === null
          ? field.definition.required
            ? t["com.myoxus.editor.field.required-unset"]({ label })
            : t["com.myoxus.editor.field.optional-unset"]({ label })
          : `${label}: ${shown}`;
      state = shown === null ? "unset" : "ready";
    } catch {
      state = "unavailable";
    }
  } else if (field.type === "metadata" && context?.template) {
    text = label;
    description = t["com.myoxus.editor.field.target-document"]({ label });
    state = "source";
  } else if (field.type === "metadata" && context?.template === false) {
    const projection = context.projection;
    state = projection.state;
    if (projection.state === "ready") {
      const candidate = projection.values.get(field.id);
      const resolved =
        candidate?.descriptor === JSON.stringify(field) ? candidate : undefined;
      if (resolved?.state === "UNSET") {
        text = "—";
        description = t["com.myoxus.editor.field.metadata-unset"]({ label });
        state = "unset";
      } else if (resolved?.state === "VALUE" && resolved.text !== null) {
        text = resolved.text;
        description = `${label}: ${resolved.text}`;
      } else {
        state = "unavailable";
      }
    } else if (projection.state === "pending") {
      text = t["Loading"]();
      description = `${label}: ${text}`;
    } else if (projection.state === "offline") {
      description = t["com.myoxus.editor.field.offline"]({ label });
    } else if (projection.state === "denied") {
      description = t["com.myoxus.editor.field.denied"]({ label });
    }
  }

  const content = (
    <span
      aria-label={description}
      title={description}
      data-document-field-id={field.id}
      data-document-field-state={state}
      data-readonly={readonly || undefined}
    >
      {text}
    </span>
  );
  if (
    !context ||
    (readonly && (field.type !== "metadata" || !context.openMetadata))
  )
    return content;
  const canConvert =
    context.template === false && (state === "ready" || state === "unset");
  const editText =
    !readonly &&
    (context.template === false || textProtected) &&
    field.type === "input" &&
    field.definition.kind === "text";
  const editMultiple =
    !readonly &&
    (context.template === false || textProtected) &&
    field.type === "input" &&
    field.definition.kind === "multi-select";
  const editSingle =
    !readonly &&
    (context.template === false || textProtected) &&
    field.type === "input" &&
    field.definition.kind === "single-select";
  const editCalendar =
    !readonly &&
    (context.template === false || textProtected) &&
    field.type === "input" &&
    (field.definition.kind === "date" || field.definition.kind === "datetime");
  const submitValue = (value: string | string[] | null) => {
    const expected = expectedValue.current;
    if (!expected || expected.type !== "input" || valueError === "stale")
      return;
    try {
      const replacement = normalizeDocumentField(
        DocumentFieldSchema.parse({ ...expected, value }),
      );
      pendingValue.current = { expected, replacement };
      setBusy(true);
      setOpened(false);
    } catch {
      setValueError("invalid");
    }
  };
  return (
    <>
      <Popover
        opened={opened}
        onChange={setOpened}
        onExitTransitionEnd={() => {
          const value = pendingValue.current;
          pendingValue.current = null;
          if (value) {
            if (!updateValue(value.expected, value.replacement)) {
              setValueError("stale");
              setOpened(true);
            }
            setBusy(false);
            return;
          }
          if (pendingMetadata.current) {
            pendingMetadata.current = false;
            setBusy(false);
            context.openMetadata?.(trigger, readonly);
            return;
          }
          const pending = pendingReplacement.current;
          pendingReplacement.current = null;
          if (pending) {
            if (!convertToText(pending.expected, pending.text)) {
              setError(true);
              setOpened(true);
            }
            setBusy(false);
            return;
          }
          if (pendingCancel.current) {
            pendingCancel.current = false;
            focusEditor("after");
          }
        }}
        withArrow
        trapFocus
        returnFocus
        fitViewport
        contentMeasure="reading"
      >
        <PopoverTarget>
          <InlineActionButton
            appearance="text"
            aria-label={description}
            aria-expanded={opened}
            disabled={busy}
            data-document-field-id={field.id}
            data-document-field-state={state}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              trigger.current = event.currentTarget;
              pendingCancel.current = false;
              setError(false);
              setValueError(null);
              if (
                (editText || editMultiple || editSingle || editCalendar) &&
                field.type === "input"
              ) {
                expectedValue.current = structuredClone(field);
                setTextDraft(
                  typeof field.value === "string" ? field.value : "",
                );
                setSelectionDraft(
                  Array.isArray(field.value) ? field.value : [],
                );
              }
              setOpened(true);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                setOpened(false);
                focusEditor(event.key === "ArrowLeft" ? "before" : "after");
              }
            }}
          >
            {text}
          </InlineActionButton>
        </PopoverTarget>
        <PopoverContent
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (editText || editMultiple || editSingle || editCalendar)
                pendingCancel.current = true;
              setOpened(false);
            }
          }}
        >
          <Stack onPointerDown={(event) => event.stopPropagation()}>
            {!editText && !editMultiple && !editSingle && !editCalendar && (
              <MyoxusText>{description}</MyoxusText>
            )}
            {editCalendar && field.type === "input" && (
              <>
                {field.definition.kind === "date" ? (
                  <LocalizedDateInput
                    label={field.definition.label}
                    description={field.definition.description}
                    required={field.definition.required}
                    locale={context.preferences.locale}
                    value={typeof field.value === "string" ? field.value : null}
                    onChange={submitValue}
                    clearable
                    fixOnBlur={false}
                    autoFocus
                    popoverProps={{
                      withinPortal: false,
                      position: "top-start",
                    }}
                    disabled={busy || valueError === "stale"}
                  />
                ) : (
                  <LocalizedDateTimeInput
                    label={field.definition.label}
                    description={field.definition.description}
                    required={field.definition.required}
                    locale={context.preferences.locale}
                    value={textDraft || null}
                    onChange={(value) => {
                      // Mantine emits intermediate date/time choices before its
                      // native confirmation; only Clear commits immediately.
                      setTextDraft(value ?? "");
                      if (value === null) submitValue(null);
                    }}
                    submitButtonProps={{
                      onClick: () => submitValue(textDraft || null),
                    }}
                    timePickerProps={{
                      hoursInputProps: {
                        onKeyDown: (event) => {
                          if (
                            event.key === "Enter" &&
                            !event.nativeEvent.isComposing
                          )
                            submitValue(textDraft || null);
                        },
                      },
                      minutesInputProps: {
                        onKeyDown: (event) => {
                          if (
                            event.key === "Enter" &&
                            !event.nativeEvent.isComposing
                          )
                            submitValue(textDraft || null);
                        },
                      },
                    }}
                    clearable
                    popoverProps={{
                      withinPortal: false,
                      position: "top-start",
                      opened: opened && !busy,
                    }}
                    disabled={busy || valueError === "stale"}
                  />
                )}
                {valueError && (
                  <MyoxusText role="alert">
                    {valueError === "stale"
                      ? t["com.myoxus.editor.field.value-stale"]()
                      : t["com.myoxus.editor.field.invalid-value"]()}
                  </MyoxusText>
                )}
              </>
            )}
            {editSingle &&
              field.type === "input" &&
              field.definition.kind === "single-select" && (
                <>
                  <FormSelect
                    label={field.definition.label}
                    description={field.definition.description}
                    required={field.definition.required}
                    data={field.definition.options.map(({ id, label }) => ({
                      value: id,
                      label,
                    }))}
                    value={typeof field.value === "string" ? field.value : null}
                    onChange={submitValue}
                    onClear={() => submitValue(null)}
                    clearable
                    clearButtonProps={{
                      "aria-label": t["com.myoxus.editor.field.clear"](),
                      "aria-hidden": false,
                    }}
                    autoFocus
                    comboboxProps={{ withinPortal: false }}
                    disabled={busy || valueError === "stale"}
                  />
                  {valueError && (
                    <MyoxusText role="alert">
                      {valueError === "stale"
                        ? t["com.myoxus.editor.field.value-stale"]()
                        : t["com.myoxus.editor.field.invalid-value"]()}
                    </MyoxusText>
                  )}
                </>
              )}
            {editText && field.type === "input" && (
              <>
                <Input
                  label={field.definition.label}
                  description={field.definition.description}
                  required={field.definition.required}
                  value={textDraft}
                  onChange={setTextDraft}
                  autoFocus
                  disabled={busy || valueError === "stale"}
                />
                {valueError && (
                  <MyoxusText role="alert">
                    {valueError === "stale"
                      ? t["com.myoxus.editor.field.value-stale"]()
                      : t["com.myoxus.editor.field.invalid-value"]()}
                  </MyoxusText>
                )}
                <Group justify="end">
                  <Button disabled={busy} onClick={() => submitValue(null)}>
                    {t["com.myoxus.editor.field.clear"]()}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      pendingCancel.current = true;
                      setOpened(false);
                    }}
                  >
                    {t["Cancel"]()}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || valueError === "stale"}
                    onClick={() => submitValue(textDraft)}
                  >
                    {t["Apply"]()}
                  </Button>
                </Group>
              </>
            )}
            {editMultiple &&
              field.type === "input" &&
              field.definition.kind === "multi-select" && (
                <>
                  <MultiSelect
                    label={field.definition.label}
                    description={field.definition.description}
                    required={field.definition.required}
                    data={field.definition.options.map(({ id, label }) => ({
                      value: id,
                      label,
                    }))}
                    value={selectionDraft}
                    onChange={setSelectionDraft}
                    comboboxProps={{ withinPortal: false }}
                    autoFocus
                    fitViewport
                    disabled={busy || valueError === "stale"}
                  />
                  {valueError && (
                    <MyoxusText role="alert">
                      {valueError === "stale"
                        ? t["com.myoxus.editor.field.value-stale"]()
                        : t["com.myoxus.editor.field.invalid-value"]()}
                    </MyoxusText>
                  )}
                  <Group justify="end">
                    <Button
                      disabled={busy || valueError === "stale"}
                      onClick={() => setSelectionDraft([])}
                    >
                      {t["com.myoxus.editor.field.clear"]()}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        pendingCancel.current = true;
                        setOpened(false);
                      }}
                    >
                      {t["Cancel"]()}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy || valueError === "stale"}
                      onClick={() => submitValue(selectionDraft)}
                    >
                      {t["Apply"]()}
                    </Button>
                  </Group>
                </>
              )}
            {error && (
              <MyoxusText role="alert">
                {t["com.myoxus.editor.field.convert-stale"]()}
              </MyoxusText>
            )}
            {context.template && !textProtected && field.type === "input" && (
              <Button
                onClick={() => {
                  setDefinitionStale(false);
                  setEditing(structuredClone(field));
                  setDefinitionOpen(true);
                  setOpened(false);
                }}
              >
                {t["com.myoxus.editor.field.edit-definition"]()}
              </Button>
            )}
            {field.type === "metadata" && context.openMetadata && (
              <Button
                onClick={() => {
                  setBusy(true);
                  pendingMetadata.current = true;
                  setOpened(false);
                }}
              >
                {t["com.myoxus.document-metadata.open"]()}
              </Button>
            )}
            {!readonly && !textProtected && (
              <Button
                disabled={!canConvert || busy}
                onClick={() => {
                  const captured = structuredClone(field);
                  const literal =
                    captured.type === "input" && state === "unset" ? "" : text;
                  setBusy(true);
                  void (
                    captured.type === "metadata"
                      ? context.verifyMetadata(captured, literal)
                      : Promise.resolve(true)
                  )
                    .then((valid) => {
                      if (!valid) {
                        setError(true);
                        setBusy(false);
                      } else {
                        // Keep the atom mounted until Mantine releases its focus trap.
                        pendingReplacement.current = {
                          expected: captured,
                          text: literal,
                        };
                        setOpened(false);
                      }
                    })
                    .catch(() => {
                      setError(true);
                      setBusy(false);
                    });
                }}
              >
                {t["com.myoxus.editor.field.convert"]()}
              </Button>
            )}
            {!readonly && !textProtected && (
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  pendingReplacement.current = {
                    expected: structuredClone(field),
                    text: "",
                  };
                  setOpened(false);
                }}
              >
                {t["com.myoxus.common.remove"]()}
              </Button>
            )}
          </Stack>
        </PopoverContent>
      </Popover>
      {editing && (
        <Modal
          open={definitionOpen}
          onOpenChange={setDefinitionOpen}
          title={t["com.myoxus.editor.field.definition"]()}
          scrollable
          returnFocus={false}
          onExitTransitionEnd={() => {
            // Commit only after the dialog releases focus; updating the Y.Text
            // can replace this Lit host and would otherwise strand focus on body.
            const pending = pendingDefinition.current;
            pendingDefinition.current = null;
            if (
              pending &&
              !updateDefinition(pending.expected, pending.replacement)
            ) {
              setDefinitionStale(true);
              setDefinitionOpen(true);
              return;
            }
            setEditing(null);
            focusEditor("after");
          }}
          contentOptions={{ onKeyDown: (event) => event.stopPropagation() }}
        >
          {definitionStale && (
            <MyoxusText role="alert">
              {t["com.myoxus.editor.field.definition-stale"]()}
            </MyoxusText>
          )}
          <DocumentFieldDefinition
            kind={editing.definition.kind}
            initial={editing}
            maxOptions={DOCUMENT_FIELD_MAX_OPTIONS}
            onCancel={() => setDefinitionOpen(false)}
            onSave={(replacement) => {
              if (definitionStale) return;
              pendingDefinition.current = { expected: editing, replacement };
              setDefinitionOpen(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
