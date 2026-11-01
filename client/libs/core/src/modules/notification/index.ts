export { NotificationFeed } from "./entities/feed";
export { NotificationCountService } from "./services/count";
export { NotificationService } from "./services/notification";
export type {
  Notification,
  NotificationBody,
  NotificationFilter,
} from "./stores/notification";
export { NotificationType } from "./stores/notification";

import type { Framework } from "@myoxus/infra";

import {
  AuthService,
  GraphQLService,
  ServerScope,
  ServerService,
} from "../server";
import { GlobalSessionState } from "../storage";
import { NotificationCountService } from "./services/count";
import { NotificationService } from "./services/notification";
import { NotificationStore } from "./stores/notification";

export function configureNotificationModule(framework: Framework) {
  framework
    .scope(ServerScope)
    .service(NotificationCountService, [NotificationStore, AuthService])
    .service(NotificationService, [
      NotificationStore,
      NotificationCountService,
      AuthService,
    ])
    .store(NotificationStore, [
      GraphQLService,
      ServerService,
      GlobalSessionState,
      AuthService,
    ]);
}
