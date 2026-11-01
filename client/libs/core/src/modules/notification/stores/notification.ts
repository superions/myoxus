import {
  getDocDefaultRoleQuery,
  type ListNotificationsQuery,
  listNotificationsQuery,
  mentionUserMutation,
  notificationCountQuery,
  type NotificationListFilterInput,
  type PaginationInput,
  readAllNotificationsMutation,
  readNotificationMutation,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import { map, of, switchMap } from "rxjs";

import type { AuthService, GraphQLService, ServerService } from "../../server";
import type { GlobalSessionState } from "../../storage";

export type Notification = NonNullable<
  ListNotificationsQuery["currentUser"]
>["notifications"]["edges"][number]["node"];

export type NotificationBody = Notification["body"];
export type NotificationFilter = NotificationListFilterInput;

export { NotificationType } from "@myoxus/graphql";

export class NotificationStore extends Store {
  constructor(
    private readonly gqlService: GraphQLService,
    private readonly serverService: ServerService,
    private readonly globalSessionState: GlobalSessionState,
    private readonly authService: AuthService,
  ) {
    super();
  }

  private countCacheKey(accountId: string) {
    return (
      "notification-count:" + this.serverService.server.id + ":" + accountId
    );
  }

  watchNotificationCountCache() {
    // The old server-only aggregate belongs to no identifiable actor and is
    // deliberately not reused when authentication changes on the same server.
    return this.authService.session.account$.pipe(
      switchMap((account) =>
        account
          ? this.globalSessionState.watch(this.countCacheKey(account.id))
          : of(0),
      ),
      map((count) => (typeof count === "number" ? count : 0)),
    );
  }

  setNotificationCountCache(count: number) {
    const account = this.authService.session.account$.value;
    if (account)
      this.globalSessionState.set(this.countCacheKey(account.id), count);
  }

  async getNotificationCount(signal?: AbortSignal) {
    const result = await this.gqlService.gql({
      query: notificationCountQuery,
      context: {
        signal,
      },
    });

    return result.currentUser?.notifications.totalCount;
  }

  async listNotification(
    pagination: PaginationInput,
    filter: NotificationFilter,
    signal?: AbortSignal,
  ) {
    const result = await this.gqlService.gql({
      query: listNotificationsQuery,
      variables: {
        filter,
        pagination,
      },
      context: {
        signal,
      },
    });

    return result.currentUser?.notifications;
  }

  readNotification(id: string) {
    return this.gqlService.gql({
      query: readNotificationMutation,
      variables: {
        id,
      },
    });
  }

  readAllNotifications() {
    return this.gqlService.gql({
      query: readAllNotificationsMutation,
    });
  }

  async documentTargetExists(workspaceId: string, docId: string) {
    const result = await this.gqlService.gql({
      query: getDocDefaultRoleQuery,
      variables: {
        docId,
        workspaceId,
      },
    });
    return result.workspace?.doc != null;
  }

  async mentionUser(
    userId: string,
    workspaceId: string,
    doc: {
      id: string;
      title: string;
      blockId?: string;
      elementId?: string;
      mode: DocMode;
    },
  ) {
    const result = await this.gqlService.gql({
      query: mentionUserMutation,
      variables: {
        input: {
          userId,
          workspaceId,
          doc,
        },
      },
    });
    return result.mentionUser;
  }
}
