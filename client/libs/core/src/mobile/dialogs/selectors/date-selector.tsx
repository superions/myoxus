import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { DatePicker, Menu } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { VirtualKeyboardService } from "../../modules/virtual-keyboard";

/**
 * A global date selector popover for mobile, mainly used in virgultum editor
 */
export const DateSelectorDialog = ({
  close,
  onSelect,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["date-selector"]>) => {
  const [selectedDate, setSelectedDate] = useState<string>();
  const keyboardService = useService(VirtualKeyboardService);
  const keyboardHeight = useLiveData(keyboardService.height$);
  const keyboardVisible = useLiveData(keyboardService.visible$);

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
        style: {
          padding: "15px 20px",
        },
      }}
      contentWrapperStyle={
        keyboardVisible
          ? {
              paddingBottom: `calc(${keyboardHeight}px + 12px)`,
            }
          : undefined
      }
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
      <div />
    </Menu>
  );
};
