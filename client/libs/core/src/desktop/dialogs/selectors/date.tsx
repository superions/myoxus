// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";
import { DatePicker, Menu } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

/**
 * Anchored date-picker popover invoked by Virgultum editor inline date actions.
 */
export const DateSelectorDialog = ({
  close,
  position,
  onSelect,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["date-selector"]>) => {
  const t = useI18n();
  const [selectedDate, setSelectedDate] = useState<string>();

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close],
  );

  const handleSelect = useCallback(
    (date?: string) => {
      setSelectedDate(date);
      onSelect?.(date);
    },
    [onSelect],
  );

  const anchorStyle = position
    ? {
        position: "fixed" as const,
        left: position[0],
        top: position[1],
        width: position[2],
        height: position[3],
      }
    : {
        position: "fixed" as const,
        left: "50%",
        top: "50%",
        width: 0,
        height: 0,
      };

  return (
    <Menu
      rootOptions={{
        modal: true,
        open: true,
        onOpenChange: handleOpenChange,
      }}
      contentOptions={{
        side: "bottom",
        sideOffset: 8,
        align: "start",
      }}
      items={
        <DatePicker
          weekDays={t["com.myoxus.common.calendar.week-days"]()}
          monthNames={t["com.myoxus.common.calendar.month-names"]()}
          todayLabel={t["com.myoxus.common.calendar.today"]()}
          value={selectedDate}
          onChange={handleSelect}
        />
      }
    >
      <div style={anchorStyle} />
    </Menu>
  );
};
