import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";
import { cssVar } from "@myoxus/theme";
import { DatePicker, Menu } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

/**
 * A global date selector popover, mainly used in virgultum editor
 */
export const DateSelectorDialog = ({
  close,
  position,
  onSelect,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["date-selector"]>) => {
  const [selectedDate, setSelectedDate] = useState<string>();

  const t = useI18n();

  const onClose = useCallback(
    (open: boolean) => {
      if (!open) {
        close();
      }
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

  return (
    <Menu
      rootOptions={{
        modal: true,
        open: true,
        onOpenChange: onClose,
      }}
      contentOptions={{
        side: "bottom",
        sideOffset: 8,
        align: "start",
        style: {
          padding: 20,
          borderRadius: 8,
          background: cssVar("backgroundPrimaryColor"),
        },
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
      {/* hack the menu positioning using the following fixed anchor */}
      <div
        style={
          position
            ? {
                position: "fixed",
                left: position[0],
                top: position[1],
                width: position[2],
                height: position[3],
              }
            : {
                position: "fixed",
                left: "50%",
                top: "50%",
                width: 0,
                height: 0,
              }
        }
      />
    </Menu>
  );
};
