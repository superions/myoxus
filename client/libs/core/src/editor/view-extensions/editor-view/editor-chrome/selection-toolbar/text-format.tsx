// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { Checkbox, IconButtonGroup, Select, Tooltip } from "@myoxus/ui-facade";
import type { SelectionAction } from "@virgultum/editor/shared/services";
import { editorGlyph as selectionGlyph } from "../glyphs";
import { ActionButton } from "./block-actions";

export function TextFormatControl({
  action,
  labelled = false,
}: {
  action: SelectionAction;
  labelled?: boolean;
}) {
  const c = action.control;
  if (c?.type === "toggle")
    return (
      <Checkbox
        label={action.label}
        checked={c.checked}
        disabled={action.disabled}
        onChange={(event) => c.change(event.target.checked)}
      />
    );
  if (c?.type !== "choice") return null;
  if (c.presentation === "icons")
    return (
      <IconButtonGroup role="group" aria-label={action.label}>
        {c.options.map((option) => (
          <ActionButton
            key={option.value}
            action={{
              id: `${action.id}.${option.value}`,
              label: option.label,
              icon: option.icon,
              active: c.value === option.value,
              disabled: action.disabled || Boolean(option.disabled),
              run: () => c.change(option.value),
            }}
          />
        ))}
      </IconButtonGroup>
    );
  return (
    <Tooltip content={action.label}>
      <Select
        aria-label={action.label}
        label={labelled ? action.label : undefined}
        contentSized
        data={c.options.map((option) => ({ ...option, label: option.label }))}
        value={c.value}
        disabled={action.disabled}
        leftSection={selectionGlyph(
          c.options.find((option) => option.value === c.value)?.icon ??
            action.icon,
        )}
        onChange={c.change}
        onDropdownOpen={c.onOpen}
        comboboxProps={{ withinPortal: false }}
      />
    </Tooltip>
  );
}
