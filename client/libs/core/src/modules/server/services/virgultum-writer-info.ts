import { OnEvent, Service } from "@myoxus/infra";
import { WriterInfoServiceExtension } from "@virgultum/editor/shared/services";

import type { Workspace } from "../../workspace";
import { WorkspaceInitialized } from "../../workspace/events";
import type { DocImpl } from "../../workspace/impls/doc";
import type { WorkspaceServerService } from "./workspace-server";

/**
 * This service is used to set the writer info for the virgultum editor.
 */
@OnEvent(WorkspaceInitialized, (i) => i.onWorkspaceInitialized)
export class VirgultumWriterInfoService extends Service {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  onWorkspaceInitialized(workspace: Workspace) {
    const setWriterInfo = (doc: DocImpl) => {
      const account = this.workspaceServerService.server?.account$.value;
      doc.storeExtensions.push(
        WriterInfoServiceExtension({
          getWriterInfo: () => {
            if (!account) {
              return null;
            }
            return {
              id: account.id,
              name: account.label,
              avatar: account.avatar,
            };
          },
        }),
      );
      const unsubscribe = doc.onRuntimeInitialized((awarenessStore) => {
        awarenessStore.awareness.setLocalStateField("user", {
          name: account?.label,
        });
      });
      this.disposables.push(unsubscribe);
    };
    for (const doc of workspace.docCollection.docs.values()) {
      setWriterInfo(doc as DocImpl);
    }
    const subscription = workspace.docCollection.meta.docMetaAdded.subscribe(
      (docId) => {
        const doc = workspace.docCollection.docs.get(docId);
        if (doc) setWriterInfo(doc as DocImpl);
      },
    );
    this.disposables.push(() => subscription.unsubscribe());
  }
}
