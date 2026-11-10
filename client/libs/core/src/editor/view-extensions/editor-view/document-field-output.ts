// SPDX-License-Identifier: AGPL-3.0-or-later
import { CoreDocumentFieldOutputProvider } from "@myoxus/core/modules/doc/services/document-field-output";
import {
  GraphQLService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { FrameworkProvider } from "@myoxus/infra";
import { DocumentFieldOutputProvider } from "@virgultum/editor/shared/services";
import { StdIdentifier } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";

export function patchDocumentFieldOutput(
  framework: FrameworkProvider,
): ExtensionType {
  return {
    setup(di) {
      di.addImpl(
        DocumentFieldOutputProvider,
        (provider) =>
          new CoreDocumentFieldOutputProvider(
            framework
              .get(WorkspaceServerService)
              .server?.scope.get(GraphQLService),
            framework.get(WorkspaceService).workspace.id,
            provider.get(StdIdentifier).store.id,
          ),
      );
    },
  };
}
