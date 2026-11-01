import { LiveData, Service } from "@myoxus/infra";
import {
  onCalendarEventChanged,
  onCalendarReminderDue,
} from "@myoxus/storage/cloud";
import dayjs from "dayjs";

import type { WorkspaceService } from "../../workspace";
import { CalendarIntegration } from "../entities/calendar";
import { ReadwiseIntegration } from "../entities/readwise";
import { IntegrationWriter } from "../entities/writer";
import { CalendarReminderDueEvent } from "../events/calendar";

const REVALIDATE_DAYS_BEFORE = 30;
const REVALIDATE_DAYS_AFTER = 60;

export class IntegrationService extends Service {
  writer = this.framework.createEntity(IntegrationWriter);
  readwise = this.framework.createEntity(ReadwiseIntegration, {
    writer: this.writer,
  });
  calendar = this.framework.createEntity(CalendarIntegration);

  constructor(private readonly workspaceService: WorkspaceService) {
    super();
    this._subscribeCalendarSocket();
  }

  importing$ = LiveData.computed((get) => {
    return get(this.readwise.importing$);
  });

  private _unsubscribeEventChanged: (() => void) | null = null;
  private _unsubscribeReminderDue: (() => void) | null = null;

  private _subscribeCalendarSocket() {
    const workspaceId = this.workspaceService.workspace.id;

    this._unsubscribeEventChanged = onCalendarEventChanged((payload) => {
      if (payload.workspaceId !== workspaceId) return;
      const now = dayjs();
      void Promise.allSettled([
        this.calendar.revalidateEventDetails(payload.eventId),
        this.calendar.revalidateEventsRange(
          now.subtract(REVALIDATE_DAYS_BEFORE, "day"),
          now.add(REVALIDATE_DAYS_AFTER, "day"),
        ),
      ]);
    });

    this._unsubscribeReminderDue = onCalendarReminderDue((payload) => {
      this.framework.emitEvent(CalendarReminderDueEvent, {
        eventId: payload.eventId,
        scheduledFor: payload.scheduledFor,
      });
    });
  }

  override dispose() {
    this._unsubscribeEventChanged?.();
    this._unsubscribeReminderDue?.();
    super.dispose();
  }
}
