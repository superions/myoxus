// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  LocalizedDateInput,
  LocalizedDateTimeInput,
  MyoxusText,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import { type ComponentProps, useEffect, useId, useRef } from "react";

export type TaskDueDraft = {
  wallTime: string | null;
  allDay: boolean;
};

type Props = {
  value: TaskDueDraft;
  onChange: (value: TaskDueDraft) => void;
  timeZone: string;
  label: string;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
  inputId?: string;
  fieldId?: string;
  popoverProps?: ComponentProps<typeof LocalizedDateInput>["popoverProps"];
  onConfirm?: () => void;
  onCancel?: () => void;
};

/** Date, mode and clear remain local drafts; the consuming native owner alone
 * decides when to create, confirm or discard a Cell value. */
export function TaskDueInput({
  value,
  onChange,
  timeZone,
  label,
  disabled,
  readOnly,
  error,
  inputId,
  fieldId,
  popoverProps,
  onConfirm,
  onCancel,
}: Props) {
  const t = useI18n();
  const instance = useId();
  const id = inputId ?? `${instance}-input`;
  const popoverId = popoverProps?.id ?? instance;
  const input = useRef<HTMLElement | null>(null);
  const locked = Boolean(disabled || readOnly);
  const controlled = popoverProps?.opened !== undefined;
  // Native pickers keep internal dropdown state; deliberate detail openings
  // instead relay focus and close events to the Cell's controlled popover.
  useEffect(() => {
    if (controlled && popoverProps?.opened && !locked) input.current?.focus();
  }, [controlled, popoverProps?.opened, value.allDay, locked]);
  const open = () => {
    if (controlled && !locked) popoverProps?.onOpen?.();
  };
  const close = () => {
    if (controlled) popoverProps?.onClose?.();
  };
  const confirm = () => {
    if (locked) return;
    close();
    onConfirm?.();
  };
  const changeWallTime = (next: string | null) => {
    if (!locked) {
      onChange({ ...value, wallTime: next || null });
      if (!next) close();
    }
  };
  return (
    <Stack
      onKeyDownCapture={(event) => {
        if (
          !onCancel ||
          locked ||
          event.key !== "Escape" ||
          !(event.target instanceof Element)
        )
          return;
        // Portal events bubble through this owner; unrelated reminder popovers
        // must never discard this draft.
        const dropdown = event.target.closest("[data-dates-dropdown]");
        if (
          event.currentTarget.contains(event.target) ||
          dropdown?.id === `${popoverId}-dropdown`
        ) {
          close();
          onCancel();
        }
      }}
    >
      {value.allDay ? (
        <LocalizedDateInput
          id={id}
          data-task-due-input="true"
          data-database-field-id={fieldId}
          aria-label={label}
          locale={t.language}
          value={value.wallTime?.slice(0, 10) ?? null}
          onChange={(next) =>
            changeWallTime(
              typeof next === "string" && next
                ? `${next.slice(0, 10)} 00:00:00`
                : null,
            )
          }
          disabled={disabled}
          readOnly={readOnly}
          error={error}
          allowDeselect={!locked}
          clearable={!locked}
          clearButtonProps={{
            "aria-label": t["com.myoxus.database.bulk.action.clear"](),
          }}
          placeholder={t.Select()}
          autoFocus={controlled && !locked}
          onFocus={
            controlled
              ? (event) => {
                  input.current = event.currentTarget;
                  open();
                }
              : undefined
          }
          onClick={controlled ? open : undefined}
          onBlur={controlled ? close : undefined}
          getDayProps={controlled ? () => ({ onClick: close }) : undefined}
          popoverProps={{ ...popoverProps, id: popoverId }}
        />
      ) : (
        <LocalizedDateTimeInput
          id={id}
          data-task-due-input="true"
          data-database-field-id={fieldId}
          aria-label={label}
          locale={t.language}
          value={value.wallTime}
          onChange={(next) =>
            changeWallTime(typeof next === "string" ? next : null)
          }
          disabled={disabled}
          readOnly={readOnly}
          error={error}
          clearable={!locked}
          clearButtonProps={{
            "aria-label": t["com.myoxus.database.bulk.action.clear"](),
          }}
          placeholder={t.Select()}
          autoFocus={controlled && !locked}
          onFocus={
            controlled
              ? (event) => {
                  input.current = event.currentTarget;
                  open();
                }
              : undefined
          }
          onClick={controlled ? open : undefined}
          popoverProps={{ ...popoverProps, id: popoverId }}
          submitButtonProps={
            onConfirm
              ? {
                  onClick: confirm,
                }
              : undefined
          }
          timePickerProps={
            onConfirm
              ? {
                  onKeyDownCapture: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      confirm();
                    }
                  },
                }
              : undefined
          }
        />
      )}
      <Switch
        disabled={locked}
        checked={value.allDay}
        onChange={(allDay) => {
          if (!locked)
            onChange({
              allDay,
              wallTime:
                allDay && value.wallTime
                  ? `${value.wallTime.slice(0, 10)} 00:00:00`
                  : value.wallTime,
            });
        }}
      >
        {t["com.myoxus.integration.calendar.all-day"]()}
      </Switch>
      {!value.allDay ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.common.timezone.value"]({ timeZone })}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}
