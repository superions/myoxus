import { Scope } from "@myoxus/infra";
import type { WorkerInitOptions } from "@myoxus/storage/worker/client";

import type { WorkspaceOpenOptions } from "../open-options";

export class WorkspaceScope extends Scope<{
  openOptions: WorkspaceOpenOptions;
  engineWorkerInitOptions: WorkerInitOptions;
}> {}
