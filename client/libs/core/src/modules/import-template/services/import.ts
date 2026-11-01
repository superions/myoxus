import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import { Service } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import { ZipTransformer } from "@virgultum/editor/widgets/linked-doc";

import { DocsService } from "../../doc";
import {
  getMyoxusWorkspaceSchema,
  type WorkspaceMetadata,
  type WorkspacesService,
} from "../../workspace";

export class ImportTemplateService extends Service {
  constructor(private readonly workspacesService: WorkspacesService) {
    super();
  }

  async importToWorkspace(
    workspaceMetadata: WorkspaceMetadata,
    docBinary: Uint8Array,
    mode: DocMode,
  ) {
    const { workspace, dispose: disposeWorkspace } =
      this.workspacesService.open({
        metadata: workspaceMetadata,
      });
    await workspace.engine.doc.waitForDocReady(workspace.id); // wait for root doc ready
    const [importedDoc] = await ZipTransformer.importDocs(
      workspace.docCollection,
      getMyoxusWorkspaceSchema(),
      new Blob([toArrayBuffer(docBinary)], {
        type: "application/zip",
      }),
    );
    const docsService = workspace.scope.get(DocsService);
    if (importedDoc) {
      // only support page mode for now
      docsService.list.setPrimaryMode(importedDoc.id, mode);
      disposeWorkspace();
      return importedDoc.id;
    } else {
      throw new Error("Failed to import doc");
    }
  }

  async importToNewWorkspace(
    flavour: string,
    workspaceName: string,
    docBinary: Uint8Array,
    // todo: support doc mode on init
  ) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    let docId: string = null!;
    const { id: workspaceId } = await this.workspacesService.create(
      flavour,
      async (docCollection, _, docStorage) => {
        docCollection.meta.initialize();
        docCollection.doc.getMap("meta").set("name", workspaceName);
        const doc = docCollection.createDoc();
        docId = doc.id;
        await docStorage.pushDocUpdate({
          docId: doc.spaceDoc.guid,
          bin: docBinary,
        });
      },
    );
    return { workspaceId, docId };
  }
}
