// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Checkbox,
  FormFieldset,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import { mermaidMessages as messages } from "@virgultum/block-mermaid";
import { useState } from "react";

/** Only explicitly opened Data exposes raw fields, as structured values rather than source text. */
export function MermaidDataValue({
  label,
  value,
  onChange,
  readonly,
  ancestors = [],
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  readonly: boolean;
  ancestors?: readonly object[];
}) {
  const [newKey, setNewKey] = useState("");
  if (value && typeof value === "object" && ancestors.includes(value))
    return <MyoxusText>{label}: ↩</MyoxusText>;
  if (readonly && (!value || typeof value !== "object"))
    return (
      <Group>
        <MyoxusText>{label}</MyoxusText>
        <MyoxusText>{String(value)}</MyoxusText>
      </Group>
    );
  if (typeof value === "boolean")
    return (
      <Checkbox
        label={label}
        checked={value}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  if (typeof value === "number")
    return (
      <NumberInput
        label={label}
        value={value}
        onChange={(next) => {
          if (typeof next === "number") onChange(next);
        }}
      />
    );
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      <FormFieldset legend={label}>
        <Stack>
          {entries.map(([key, item]) => (
            <Group key={key}>
              <MermaidDataValue
                label={key}
                value={item}
                readonly={readonly}
                ancestors={[...ancestors, value]}
                onChange={(next) => {
                  const copy = Array.isArray(value) ? [...value] : { ...value };
                  (copy as Record<string, unknown>)[key] = next;
                  onChange(copy);
                }}
              />
              {!readonly ? (
                <Button
                  variant="plain"
                  onClick={() => {
                    const copy = Array.isArray(value)
                      ? value.filter((_item, index) => String(index) !== key)
                      : Object.fromEntries(
                          entries.filter(([field]) => field !== key),
                        );
                    onChange(copy);
                  }}
                >
                  {messages.visualDelete()}
                </Button>
              ) : null}
            </Group>
          ))}
          {!readonly ? (
            <Group>
              {!Array.isArray(value) ? (
                <MyoxusTextInput
                  label={messages.timelineConfigProperty(newKey)}
                  value={newKey}
                  onChange={setNewKey}
                />
              ) : null}
              <Button
                disabled={
                  !Array.isArray(value) && (!newKey.trim() || newKey in value)
                }
                onClick={() => {
                  onChange(
                    Array.isArray(value)
                      ? [...value, ""]
                      : { ...value, [newKey]: "" },
                  );
                  setNewKey("");
                }}
              >
                {messages.architectureAdd()}
              </Button>
            </Group>
          ) : null}
        </Stack>
      </FormFieldset>
    );
  }
  return (
    <MyoxusTextInput
      label={label}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={onChange}
    />
  );
}
