// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { createOperationUuid } from "@myoxus/core/utils/uuid";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DeleteIcon,
} from "@myoxus/icons/react";
import {
  Alert,
  Button,
  Checkbox,
  FormSelect,
  Group,
  IconButton,
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  MultiSelect,
  Stack,
} from "@myoxus/ui-facade";
import {
  DocumentFieldSchema,
  type DocumentField,
} from "@virgultum/shared/types";
import { useState } from "react";
import { normalizeDocumentField } from "../../../modules/template-doc/services/template-inputs";

type InputField = Extract<DocumentField, { type: "input" }>;
export type DocumentInputKind = InputField["definition"]["kind"];
type Option = { id: string; label: string };

/** Edit a local definition draft; existing occurrence, answer and option IDs survive. */
export function DocumentFieldDefinition({
  kind,
  maxOptions,
  initial,
  onCancel,
  onSave,
}: {
  kind: DocumentInputKind;
  maxOptions: number;
  initial?: InputField;
  onCancel: () => void;
  onSave: (field: InputField) => void;
}) {
  const t = useI18n();
  const [label, setLabel] = useState(initial?.definition.label ?? "");
  const [description, setDescription] = useState(
    initial?.definition.description ?? "",
  );
  const [required, setRequired] = useState(
    initial?.definition.required ?? false,
  );
  const initialDefault = initial?.definition.default;
  const [hasDefault, setHasDefault] = useState(initialDefault != null);
  const [scalar, setScalar] = useState<string | null>(
    typeof initialDefault === "string" ? initialDefault : null,
  );
  const [multiple, setMultiple] = useState<string[]>(
    Array.isArray(initialDefault) ? [...initialDefault] : [],
  );
  const [options, setOptions] = useState<Option[]>(() =>
    initial && "options" in initial.definition
      ? structuredClone(initial.definition.options)
      : [{ id: createOperationUuid(), label: "" }],
  );
  const [invalid, setInvalid] = useState(false);
  const hasOptions = kind === "single-select" || kind === "multi-select";
  const selectOptions = options.map((option) => ({
    value: option.id,
    label: option.label,
  }));
  const move = (index: number, direction: -1 | 1) => {
    setOptions((current) => {
      const next = [...current];
      const other = index + direction;
      if (other < 0 || other >= next.length) return current;
      [next[index], next[other]] = [next[other], next[index]];
      return next;
    });
  };
  const save = () => {
    try {
      const optionLabels = options.map((option) =>
        option.label.trim().toLocaleLowerCase(),
      );
      if (hasOptions && new Set(optionLabels).size !== optionLabels.length)
        throw new Error("Duplicate option labels");
      if (
        hasDefault &&
        (kind === "date" || kind === "datetime" || kind === "single-select") &&
        scalar === null
      )
        throw new Error("Default value required");
      const field = normalizeDocumentField(
        DocumentFieldSchema.parse({
          type: "input",
          id: initial?.id ?? createOperationUuid(),
          definition: {
            kind,
            label,
            ...(description ? { description } : {}),
            required,
            ...(hasOptions ? { options } : {}),
            ...(hasDefault
              ? { default: kind === "multi-select" ? multiple : scalar }
              : {}),
          },
          value: initial?.value ?? (kind === "multi-select" ? [] : null),
        }),
      );
      if (field.type !== "input") throw new Error("Input field required");
      onSave(field);
    } catch {
      setInvalid(true);
    }
  };
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Stack>
        <Input
          label={t["com.myoxus.editor.field.label"]()}
          value={label}
          onChange={setLabel}
          required
          autoFocus
        />
        <Input
          label={t["com.myoxus.common.description"]()}
          value={description}
          onChange={setDescription}
        />
        <Checkbox
          label={t["com.myoxus.page-properties.property.required"]()}
          checked={required}
          onChange={(_, value) => setRequired(value)}
        />
        {hasOptions && (
          <Stack>
            {options.map((option, index) => (
              <Group key={option.id} wrap="nowrap">
                <Input
                  label={t["com.myoxus.editor.field.option-label"]({
                    number: String(index + 1),
                  })}
                  value={option.label}
                  onChange={(value) =>
                    setOptions((current) =>
                      current.map((item) =>
                        item.id === option.id
                          ? { ...item, label: value }
                          : item,
                      ),
                    )
                  }
                  required
                />
                <IconButton
                  type="button"
                  aria-label={t["com.myoxus.editor.field.option-up"]({
                    number: String(index + 1),
                  })}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ChevronUpIcon />
                </IconButton>
                <IconButton
                  type="button"
                  aria-label={t["com.myoxus.editor.field.option-down"]({
                    number: String(index + 1),
                  })}
                  disabled={index === options.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronDownIcon />
                </IconButton>
                <IconButton
                  type="button"
                  aria-label={t["com.myoxus.editor.field.remove-option"]({
                    number: String(index + 1),
                  })}
                  disabled={options.length === 1}
                  onClick={() => {
                    setOptions((current) =>
                      current.filter((item) => item.id !== option.id),
                    );
                    setMultiple((current) =>
                      current.filter((id) => id !== option.id),
                    );
                    if (scalar === option.id) setScalar(null);
                  }}
                >
                  <DeleteIcon />
                </IconButton>
              </Group>
            ))}
            <Button
              type="button"
              disabled={options.length >= maxOptions}
              onClick={() =>
                setOptions((current) => [
                  ...current,
                  { id: createOperationUuid(), label: "" },
                ])
              }
            >
              {t["com.myoxus.editor.field.add-option"]()}
            </Button>
          </Stack>
        )}
        <Checkbox
          label={t["com.myoxus.editor.field.use-default"]()}
          checked={hasDefault}
          onChange={(_, value) => setHasDefault(value)}
        />
        {hasDefault &&
          (kind === "text" ? (
            <Input
              label={t["com.myoxus.editor.field.default-value"]()}
              value={scalar ?? ""}
              onChange={setScalar}
            />
          ) : kind === "date" ? (
            <LocalizedDateInput
              label={t["com.myoxus.editor.field.default-value"]()}
              locale={t.language}
              value={scalar}
              onChange={setScalar}
              clearable
            />
          ) : kind === "datetime" ? (
            <LocalizedDateTimeInput
              label={t["com.myoxus.editor.field.default-value"]()}
              locale={t.language}
              value={scalar}
              onChange={setScalar}
              clearable
            />
          ) : kind === "single-select" ? (
            <FormSelect
              label={t["com.myoxus.editor.field.default-value"]()}
              data={selectOptions}
              value={scalar}
              onChange={setScalar}
              onClear={() => setScalar(null)}
              clearable
            />
          ) : (
            <MultiSelect
              label={t["com.myoxus.editor.field.default-value"]()}
              data={selectOptions}
              value={multiple}
              onChange={setMultiple}
              clearable
            />
          ))}
        {invalid && (
          <Alert
            role="alert"
            title={t["com.myoxus.editor.field.invalid-definition"]()}
          />
        )}
        <Group justify="flex-end">
          <Button type="button" onClick={onCancel}>
            {t.Cancel()}
          </Button>
          <Button type="submit" variant="primary">
            {t.Apply()}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
