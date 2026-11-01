import { type Framework } from "@myoxus/infra";

import { GlobalContextService } from "../global-context";
import { ServersService } from "../server";
import { TelemetryService } from "./services/telemetry";

export function configureTelemetryModule(framework: Framework) {
  framework.service(TelemetryService, [GlobalContextService, ServersService]);
}
