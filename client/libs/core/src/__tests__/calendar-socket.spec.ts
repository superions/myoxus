/**
 * @vitest-environment happy-dom
 */

import { Framework, LiveData } from "@myoxus/infra";
import * as cloudSocket from "@myoxus/storage/cloud";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CalendarIntegration } from "../modules/integration/entities/calendar";
import { ReadwiseIntegration } from "../modules/integration/entities/readwise";
import { IntegrationWriter } from "../modules/integration/entities/writer";
import {
  CalendarReminderDueEvent,
  type CalendarReminderDuePayload,
} from "../modules/integration/events/calendar";
import { IntegrationService } from "../modules/integration/services/integration";
import { CalendarStore } from "../modules/integration/store/calendar";
import { WorkspaceService } from "../modules/workspace";

const WS_ID = "ws-core02-test";

function makeMockStore(): CalendarStore {
  return {
    fetchAccounts: vi.fn().mockResolvedValue([]),
    fetchWorkspaceCalendars: vi.fn().mockResolvedValue([]),
    updateWorkspaceCalendars: vi.fn(),
    fetchEvents: vi.fn().mockResolvedValue([]),
    fetchEvent: vi.fn().mockResolvedValue(null),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    fetchTags: vi.fn().mockResolvedValue([]),
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
    fetchSettings: vi.fn().mockResolvedValue(null),
    updateSettings: vi.fn(),
    exportIcs: vi.fn().mockResolvedValue(""),
    importIcs: vi.fn(),
  } as unknown as CalendarStore;
}

function makeFramework() {
  const mockStore = makeMockStore();
  const framework = new Framework();

  framework.service(WorkspaceService, { workspace: { id: WS_ID } } as any);
  framework.store(CalendarStore, mockStore);
  framework.entity(CalendarIntegration, [CalendarStore]);
  framework.entity(IntegrationWriter, () => ({}) as any);
  framework.entity(
    ReadwiseIntegration,
    () => ({ importing$: new LiveData(false) }) as any,
  );
  framework.service(IntegrationService, [WorkspaceService]);

  return { framework, mockStore };
}

describe("IntegrationService — calendar socket subscription (CORE-02)", () => {
  let onChangedCb:
    ((p: { workspaceId: string; eventId: string; op: string }) => void) | null =
    null;
  let onReminderCb:
    ((p: { eventId: string; scheduledFor: string }) => void) | null = null;

  beforeEach(() => {
    onChangedCb = null;
    onReminderCb = null;
    vi.spyOn(cloudSocket, "onCalendarEventChanged").mockImplementation((cb) => {
      onChangedCb = cb as any;
      return () => {
        onChangedCb = null;
      };
    });
    vi.spyOn(cloudSocket, "onCalendarReminderDue").mockImplementation((cb) => {
      onReminderCb = cb as any;
      return () => {
        onReminderCb = null;
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calendar:event_changed refreshes the event reference and calendar range", async () => {
    const { framework } = makeFramework();
    const provider = framework.provider();
    const service = provider.get(IntegrationService);

    const revalidateSpy = vi
      .spyOn(service.calendar, "revalidateEventsRange")
      .mockResolvedValue([]);
    const eventSpy = vi
      .spyOn(service.calendar, "revalidateEventDetails")
      .mockResolvedValue(null);

    expect(onChangedCb).not.toBeNull();
    onChangedCb!({ workspaceId: WS_ID, eventId: "e1", op: "created" });
    await new Promise((r) => setTimeout(r, 0));

    expect(revalidateSpy).toHaveBeenCalledOnce();
    expect(eventSpy).toHaveBeenCalledWith("e1");
  });

  test("calendar:event_changed for different workspace is ignored", async () => {
    const { framework } = makeFramework();
    const provider = framework.provider();
    const service = provider.get(IntegrationService);

    const revalidateSpy = vi
      .spyOn(service.calendar, "revalidateEventsRange")
      .mockResolvedValue([]);
    const eventSpy = vi
      .spyOn(service.calendar, "revalidateEventDetails")
      .mockResolvedValue(null);

    onChangedCb!({ workspaceId: "other-ws", eventId: "e2", op: "updated" });
    await new Promise((r) => setTimeout(r, 0));

    expect(revalidateSpy).not.toHaveBeenCalled();
    expect(eventSpy).not.toHaveBeenCalled();
  });

  test("calendar_reminder_due emits CalendarReminderDueEvent", () => {
    const { framework } = makeFramework();
    const provider = framework.provider();
    provider.get(IntegrationService);

    const received: CalendarReminderDuePayload[] = [];
    provider.eventBus.on(CalendarReminderDueEvent, (p) => received.push(p));

    expect(onReminderCb).not.toBeNull();
    onReminderCb!({ eventId: "r1", scheduledFor: "2026-04-25T10:00:00Z" });

    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe("r1");
    expect(received[0].scheduledFor).toBe("2026-04-25T10:00:00Z");
  });
});
