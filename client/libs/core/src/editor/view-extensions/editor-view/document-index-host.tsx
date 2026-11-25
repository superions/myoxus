// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CoreDocumentIndexProvider,
  documentIndexRegionalPreferences,
} from "@myoxus/core/modules/doc/services/document-index";
import {
  GraphQLService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { FrameworkProvider } from "@myoxus/infra";
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import {
  DocumentIndexHost,
  DocumentIndexOutputProvider,
} from "@virgultum/editor/shared/services";
import type { ExtensionType } from "@virgultum/editor/store";
import { Directory, Configuration } from "./document-index";

export function patchDocumentIndex(
  framework: FrameworkProvider,
  mountPortal: MountReactPortal,
): ExtensionType {
  return {
    setup(di) {
      di.addImpl(DocumentIndexOutputProvider, () => {
        const server = framework.get(WorkspaceServerService).server;
        return new CoreDocumentIndexProvider(
          server?.scope.get(GraphQLService),
          framework.get(WorkspaceService).workspace.id,
          server?.baseUrl,
          () =>
            documentIndexRegionalPreferences(
              framework.get(WorkspaceServerService).server,
            ),
        );
      });
      di.addImpl(DocumentIndexHost, () => ({
        mount: (anchor, model) =>
          mountPortal(anchor, <Directory model={model} />),
        configure: (anchor, value, apply, close) =>
          mountPortal(
            anchor,
            <Configuration value={value} apply={apply} close={close} />,
          ),
      }));
    },
  };
}
