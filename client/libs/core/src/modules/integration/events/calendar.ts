import { createEvent, type FrameworkEvent } from "@myoxus/infra";

export type CalendarReminderDuePayload = {
  eventId: string;
  scheduledFor: string;
};

export const CalendarReminderDueEvent: FrameworkEvent<CalendarReminderDuePayload> =
  createEvent<CalendarReminderDuePayload>("CalendarReminderDue");
