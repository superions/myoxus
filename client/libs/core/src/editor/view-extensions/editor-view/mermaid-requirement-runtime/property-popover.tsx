// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Checkbox,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Textarea,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  REQUIREMENT_RISKS,
  REQUIREMENT_VERIFICATION_METHODS,
  readRequirementString,
  sourceRequirementString,
  type RequirementReactHostProps,
} from "@virgultum/block-mermaid";

export type RequirementPropertyName =
  "id" | "text" | "risk" | "verifymethod" | "type" | "docref";

export function validRequirementPropertyValue(
  property: RequirementPropertyName,
  value: string,
) {
  return property === "risk"
    ? (REQUIREMENT_RISKS as readonly string[]).includes(value)
    : property === "verifymethod"
      ? (REQUIREMENT_VERIFICATION_METHODS as readonly string[]).includes(value)
      : readRequirementString(sourceRequirementString(value)) === value;
}

/** Compose the field's existing form roles at its provider anchor. A removal
 * checkbox is a draft intent; only the common Save removes all its providers. */
export function RequirementPropertyControl({
  property,
  label,
  value,
  providers,
  model,
  removed,
  disabled,
  onChange,
  onRemove,
  autoFocus,
}: {
  property: RequirementPropertyName;
  label: string;
  value: string;
  providers: readonly string[];
  model: RequirementReactHostProps["model"];
  removed: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onRemove: (removed: boolean) => void;
  autoFocus?: boolean;
}) {
  const t = useI18n(),
    records = providers.flatMap(
      (key) =>
        model.sourceDocument?.records.find(
          (record) => record.sourceKey === key,
        ) ?? [],
    );
  const absent = !providers.length && value === "";
  const error =
    !removed && !absent && !validRequirementPropertyValue(property, value)
      ? m.pieInvalid()
      : undefined;
  const description =
    absent || removed
      ? t["com.myoxus.document-metadata.value.not-set"]()
      : undefined;
  const options =
    property === "risk"
      ? REQUIREMENT_RISKS
      : property === "verifymethod"
        ? REQUIREMENT_VERIFICATION_METHODS
        : undefined;
  return (
    <>
      {options ? (
        <Select
          label={label}
          description={description}
          error={error}
          comboboxProps={{ withinPortal: false }}
          value={value}
          disabled={disabled || removed}
          data={[
            ...(!providers.length && value === ""
              ? [
                  {
                    value: "",
                    label: t["com.myoxus.document-metadata.value.not-set"](),
                  },
                ]
              : []),
            ...options.map((value) => ({ value, label: value })),
          ]}
          onChange={onChange}
        />
      ) : property === "text" ? (
        <Textarea
          label={label}
          description={description}
          error={error}
          autoFocus={autoFocus}
          value={value}
          disabled={disabled || removed}
          autosize
          onChange={onChange}
        />
      ) : (
        <MyoxusTextInput
          label={label}
          description={description}
          error={error}
          autoFocus={autoFocus}
          value={value}
          disabled={disabled || removed}
          onChange={onChange}
        />
      )}
      {records.length > 1 ? (
        <>
          <MyoxusText>
            {t["com.myoxus.editor.mermaid.requirement-property-providers"]()}
          </MyoxusText>
          {records.map((record, index) => (
            <MyoxusText key={record.sourceKey}>
              {index === 0
                ? t["com.myoxus.editor.mermaid.effective-value"]({
                    value: `${record.range.line}: ${record.raw}`,
                  })
                : `${record.range.line}: ${record.raw}`}
            </MyoxusText>
          ))}
        </>
      ) : null}
      <Checkbox
        label={t["com.myoxus.editor.mermaid.requirement-property-remove"]({
          field: label,
        })}
        checked={removed}
        disabled={disabled || absent}
        onChange={(event) => onRemove(event.currentTarget.checked)}
      />
    </>
  );
}
