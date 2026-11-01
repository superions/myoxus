import { type Framework } from "@myoxus/infra";

import { DesktopApi } from "./entities/desktop-api";
import { DesktopApiImpl } from "./impl";
import { DesktopApiProvider } from "./provider";
import { DesktopApiService } from "./service/desktop-api";

export function configureDesktopApiModule(framework: Framework) {
  framework
    .impl(DesktopApiProvider, DesktopApiImpl)
    .entity(DesktopApi, [DesktopApiProvider])
    .service(DesktopApiService, [DesktopApi]);
}

export { DesktopApiService } from "./service/desktop-api";
export type {
  ClientEvents,
  TabViewsMetaSchema,
} from "@myoxus/desktop-api-contract";
