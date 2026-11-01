export {
  type AllDocsSavedFilter,
  type AllDocsSavedFilterInput,
  AllDocsSavedFiltersService,
} from "./saved-filters";

import type { Framework } from "@myoxus/infra";

import { WorkspaceScope } from "../workspace";
import { WorkspaceLocalState } from "../workspace/providers/storage";
import { AllDocsSavedFiltersService } from "./saved-filters";

export function configureAllDocsModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(AllDocsSavedFiltersService, [WorkspaceLocalState]);
}
