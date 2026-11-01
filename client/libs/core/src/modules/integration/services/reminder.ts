import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { OnEvent, Service } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import dayjs from "dayjs";

import { ApplicationStarted } from "../../lifecycle";
import {
  CalendarReminderDueEvent,
  type CalendarReminderDuePayload,
} from "../events/calendar";
import type { IntegrationService } from "./integration";

// Module-level dedup: prevents re-firing within the same tab session.
const _dispatched = new Set<string>();

@OnEvent(ApplicationStarted, (s) => s.handleApplicationStarted)
@OnEvent(CalendarReminderDueEvent, (s) => s.handleReminderDue)
export class CalendarReminderService extends Service {
  constructor(private readonly integrationService: IntegrationService) {
    super();
  }

  handleApplicationStarted() {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().catch(() => {
        // denied or unsupported — no action needed
      });
    }
  }

  handleReminderDue(payload: CalendarReminderDuePayload) {
    const dedupKey = `${payload.eventId}:${payload.scheduledFor}`;
    if (_dispatched.has(dedupKey)) return;
    _dispatched.add(dedupKey);

    const eventTitle = this._findEventTitle(payload.eventId) ?? "Termin";
    const minutesUntil = dayjs(payload.scheduledFor).diff(dayjs(), "minute");
    const timeLabel = minutesUntil <= 0 ? "jetzt" : `in ${minutesUntil} min`;
    const toastTitle = `Termin ${timeLabel}`;

    // CORE-03-A: In-app toast
    notify({
      style: "normal",
      title: toastTitle,
      message: eventTitle,
    });

    // DESKTOP-01-B: In Electron, delegate to native OS notification via IPC
    const electronApis = getDesktopBridge()?.apis;
    const startDate =
      this._findEventStartDate(payload.eventId) ??
      dayjs(payload.scheduledFor).format("YYYY-MM-DD");
    if (electronApis?.ui?.showCalendarReminderNotification) {
      electronApis.ui
        .showCalendarReminderNotification(
          toastTitle,
          eventTitle,
          payload.eventId,
          startDate,
        )
        .catch(() => {
          // fallthrough to browser API below
        });
      return;
    }

    // CORE-03-B: Browser Notification when document not visible
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(toastTitle, {
          body: eventTitle,
          tag: payload.eventId,
        });
      } catch {
        // Notification API unavailable (e.g. requires service worker in some browsers)
      }
    }
  }

  private _findEventTitle(eventId: string): string | null {
    for (const events of this.integrationService.calendar.eventsByDateMap$.value.values()) {
      const found = events.find((e) => e.id === eventId);
      if (found) return found.title;
    }
    return null;
  }

  private _findEventStartDate(eventId: string): string | null {
    for (const events of this.integrationService.calendar.eventsByDateMap$.value.values()) {
      const found = events.find((e) => e.id === eventId);
      if (found) return dayjs(found.startAtUtc).format("YYYY-MM-DD");
    }
    return null;
  }
}
