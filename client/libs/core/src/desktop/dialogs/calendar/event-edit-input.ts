// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateWorkspaceEventInput } from "@myoxus/graphql";

type ReminderDraft = { reminderMinutes: number | ""; reminderChannel: string };

/** The single visible control must not replace an unchanged multi-definition
 * set. Omission preserves it; an explicitly cleared control sends an empty set. */
export function eventReminderPatch(
  value: ReminderDraft,
  basis: ReminderDraft,
): Pick<UpdateWorkspaceEventInput, "reminders"> {
  if (
    value.reminderMinutes === basis.reminderMinutes &&
    value.reminderChannel === basis.reminderChannel
  )
    return {};
  return {
    reminders:
      value.reminderMinutes === ""
        ? []
        : [
            {
              minutesBefore: value.reminderMinutes,
              channel: value.reminderChannel,
            },
          ],
  };
}
