import {
  type CalendarAccountsQuery,
  calendarAccountsQuery,
  type CalendarEventQuery,
  calendarEventQuery,
  type CalendarEventsQuery,
  calendarEventsQuery,
  type CalendarEventTagsQuery,
  calendarEventTagsQuery,
  type CalendarIcsImportResult,
  type CreateEventTagInput,
  createEventTagMutation,
  type CreateWorkspaceEventInput,
  type CreateWorkspaceEventMutation,
  createWorkspaceEventMutation,
  deleteEventTagMutation,
  deleteWorkspaceEventMutation,
  exportWorkspaceCalendarIcsQuery,
  importWorkspaceCalendarIcsMutation,
  type NativeEventScope,
  type UpdateEventTagInput,
  updateEventTagMutation,
  type UpdateWorkspaceCalendarSettingsInput,
  updateWorkspaceCalendarSettingsMutation,
  type UpdateWorkspaceCalendarsMutation,
  updateWorkspaceCalendarsMutation,
  type UpdateWorkspaceEventInput,
  updateWorkspaceEventMutation,
  type WorkspaceCalendarItemInput,
  type WorkspaceCalendarSettingsQuery,
  workspaceCalendarSettingsQuery,
  type WorkspaceCalendarsQuery,
  workspaceCalendarsQuery,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";

export class CalendarStore extends Store {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
  }

  private get gql() {
    return this.workspaceServerService.server?.gql;
  }

  private get workspaceId() {
    return this.workspaceService.workspace.id;
  }

  async fetchAccounts(signal?: AbortSignal) {
    const gql = this.gql;
    if (!gql)
      return [] satisfies NonNullable<
        CalendarAccountsQuery["currentUser"]
      >["calendarAccounts"];
    const data = await gql({
      query: calendarAccountsQuery,
      context: { signal },
    });
    return data.currentUser?.calendarAccounts ?? [];
  }

  async fetchWorkspaceCalendars(signal?: AbortSignal) {
    const gql = this.gql;
    if (!gql)
      return [] satisfies NonNullable<
        WorkspaceCalendarsQuery["workspace"]
      >["calendars"];
    const data = await gql({
      query: workspaceCalendarsQuery,
      variables: { workspaceId: this.workspaceId },
      context: { signal },
    });
    return data.workspace?.calendars ?? [];
  }

  async updateWorkspaceCalendars(items: WorkspaceCalendarItemInput[]) {
    const gql = this.gql;
    if (!gql) {
      throw new Error("No graphql service available");
    }
    const data = await gql({
      query: updateWorkspaceCalendarsMutation,
      variables: {
        input: {
          workspaceId: this.workspaceId,
          items,
        },
      },
    });
    return data.updateWorkspaceCalendars satisfies UpdateWorkspaceCalendarsMutation["updateWorkspaceCalendars"];
  }

  async fetchEvents(
    workspaceCalendarId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ) {
    const gql = this.gql;
    if (!gql)
      return [] satisfies NonNullable<
        CalendarEventsQuery["workspace"]
      >["calendars"][number]["events"];
    const data = await gql({
      query: calendarEventsQuery,
      variables: {
        workspaceId: this.workspaceId,
        from,
        to,
      },
      context: { signal },
    });
    const calendars = data.workspace?.calendars ?? [];
    const calendar = calendars.find((item) => item.id === workspaceCalendarId);
    return calendar?.events ?? [];
  }

  async fetchEvent(eventId: string, signal?: AbortSignal) {
    const gql = this.gql;
    if (!gql) return null satisfies CalendarEventQuery["calendarEvent"];
    const data = await gql({
      query: calendarEventQuery,
      variables: {
        workspaceId: this.workspaceId,
        eventId,
      },
      context: { signal },
    });
    return data.calendarEvent;
  }

  async createEvent(input: Omit<CreateWorkspaceEventInput, "workspaceId">) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    const data = await gql({
      query: createWorkspaceEventMutation,
      variables: { input: { ...input, workspaceId: this.workspaceId } },
    });
    return data.createWorkspaceEvent satisfies CreateWorkspaceEventMutation["createWorkspaceEvent"];
  }

  async updateEvent(
    eventId: string,
    scope: NativeEventScope,
    input: UpdateWorkspaceEventInput,
    instanceStart?: string,
  ) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    const data = await gql({
      query: updateWorkspaceEventMutation,
      variables: {
        eventId,
        workspaceId: this.workspaceId,
        scope,
        instanceStart: instanceStart ?? null,
        input,
      },
    });
    return data.updateWorkspaceEvent;
  }

  async deleteEvent(
    eventId: string,
    scope: NativeEventScope,
    instanceStart?: string,
  ) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    await gql({
      query: deleteWorkspaceEventMutation,
      variables: {
        eventId,
        workspaceId: this.workspaceId,
        scope,
        instanceStart: instanceStart ?? null,
      },
    });
  }

  async fetchTags(signal?: AbortSignal) {
    const gql = this.gql;
    if (!gql) return [] satisfies CalendarEventTagsQuery["calendarEventTags"];
    const data = await gql({
      query: calendarEventTagsQuery,
      variables: { workspaceId: this.workspaceId },
      context: { signal },
    });
    return data.calendarEventTags;
  }

  async createTag(input: Omit<CreateEventTagInput, "workspaceId">) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    const data = await gql({
      query: createEventTagMutation,
      variables: {
        input: { ...input, workspaceId: this.workspaceId },
      },
    });
    return data.createEventTag;
  }

  async updateTag(
    tagId: string,
    input: Omit<UpdateEventTagInput, "workspaceId">,
  ) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    const data = await gql({
      query: updateEventTagMutation,
      variables: { tagId, input: { ...input, workspaceId: this.workspaceId } },
    });
    return data.updateEventTag;
  }

  async deleteTag(tagId: string) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    await gql({
      query: deleteEventTagMutation,
      variables: { tagId, workspaceId: this.workspaceId },
    });
  }

  async fetchSettings(signal?: AbortSignal) {
    const gql = this.gql;
    if (!gql)
      return null satisfies WorkspaceCalendarSettingsQuery["workspaceCalendarSettings"];
    const data = await gql({
      query: workspaceCalendarSettingsQuery,
      variables: { workspaceId: this.workspaceId },
      context: { signal },
    });
    return data.workspaceCalendarSettings;
  }

  async updateSettings(
    input: Omit<UpdateWorkspaceCalendarSettingsInput, "workspaceId">,
  ) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    const data = await gql({
      query: updateWorkspaceCalendarSettingsMutation,
      variables: {
        input: { ...input, workspaceId: this.workspaceId },
      },
    });
    return data.updateWorkspaceCalendarSettings;
  }

  async exportIcs(from: string, to: string, signal?: AbortSignal) {
    const gql = this.gql;
    if (!gql) return "";
    const data = await gql({
      query: exportWorkspaceCalendarIcsQuery,
      variables: { workspaceId: this.workspaceId, from, to },
      context: { signal },
    });
    return data.exportWorkspaceCalendarIcs;
  }

  async importIcs(icsBody: string) {
    const gql = this.gql;
    if (!gql) throw new Error("No graphql service available");
    const data = await gql({
      query: importWorkspaceCalendarIcsMutation,
      variables: { workspaceId: this.workspaceId, icsBody },
    });
    return data.importWorkspaceCalendarIcs satisfies CalendarIcsImportResult;
  }
}
