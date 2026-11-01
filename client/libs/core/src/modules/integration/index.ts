import type { Framework } from "@myoxus/infra";

import { WorkspaceDBService } from "../db";
import { DocScope, DocService, DocsService } from "../doc";
import { WorkspaceServerService } from "../server";
import { GlobalState } from "../storage";
import { TagService } from "../tag";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { CalendarIntegration } from "./entities/calendar";
import { ReadwiseIntegration } from "./entities/readwise";
import { ReadwiseCrawler } from "./entities/readwise-crawler";
import { IntegrationWriter } from "./entities/writer";
import { IntegrationService } from "./services/integration";
import { IntegrationPropertyService } from "./services/integration-property";
import { CalendarReminderService } from "./services/reminder";
import { CalendarStore } from "./store/calendar";
import { IntegrationRefStore } from "./store/integration-ref";
import { ReadwiseStore } from "./store/readwise";

export { IntegrationService };
export { CalendarReminderService };
export { CalendarIntegration } from "./entities/calendar";
export {
  CalendarReminderDueEvent,
  type CalendarReminderDuePayload,
} from "./events/calendar";
export type { CalendarEvent } from "./type";
export { IntegrationTypeIcon } from "./views/icon";

export function configureIntegrationModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .store(IntegrationRefStore, [WorkspaceDBService, DocsService])
    .store(ReadwiseStore, [
      GlobalState,
      WorkspaceService,
      WorkspaceServerService,
    ])
    .service(IntegrationService, [WorkspaceService])
    .entity(ReadwiseCrawler, [ReadwiseStore])
    .entity(IntegrationWriter, [WorkspaceService, TagService])
    .entity(ReadwiseIntegration, [
      IntegrationRefStore,
      ReadwiseStore,
      DocsService,
    ])
    .store(CalendarStore, [WorkspaceService, WorkspaceServerService])
    .entity(CalendarIntegration, [CalendarStore])
    .service(CalendarReminderService, [IntegrationService])
    .scope(DocScope)
    .service(IntegrationPropertyService, [DocService]);
}
