import { WorkspaceScope } from "@myoxus/core/modules/workspace";
import { type Framework } from "@myoxus/infra";

import { MobileSearchService } from "./service/search";

export { MobileSearchService };

export function configureMobileSearchModule(framework: Framework) {
  framework.scope(WorkspaceScope).service(MobileSearchService);
}
