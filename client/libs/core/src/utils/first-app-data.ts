// the following import is used to ensure the block suite editor effects are run
import "../editor/virgultum/doc-editor";

import { DebugLogger } from "@myoxus/debug";
import { DEFAULT_WORKSPACE_NAME } from "@myoxus/env/constant";
import { WorkspaceInitialContentPolicy } from "@myoxus/graphql";
import { I18n } from "@myoxus/i18n";

import { OrganizeService } from "../modules/organize";
import { BuiltinTemplateReconcilerService } from "../modules/template-doc";
import { type WorkspacesService } from "../modules/workspace";
import { canUseLocalWorkspaces } from "../modules/workspace/local-workspace-capability";
import { onboardingDocumentSlugs } from "../modules/template-doc/services/source-metadata";

const DEFAULT_SHOWCASE_SLUG = "getting-started-myoxus";
const FOLDER_GUIDE_SLUG = "using-folders-myoxus";

export async function buildShowcaseWorkspace(
  workspacesService: WorkspacesService,
  flavour: string,
  workspaceName: string,
) {
  const meta = await workspacesService.create(
    flavour,
    async (docCollection) => {
      docCollection.meta.initialize();
      docCollection.doc.getMap("meta").set("name", workspaceName);
    },
  );

  if (meta.initialContentPolicy === WorkspaceInitialContentPolicy.Empty)
    return { meta, defaultDocId: undefined };

  const { workspace, dispose } = workspacesService.open({ metadata: meta });

  try {
    await workspace.engine.doc.waitForDocReady(workspace.id);

    const reconciler = workspace.scope.get(BuiltinTemplateReconcilerService);
    const seededTemplateDocIds = await reconciler.ensureBuiltinTemplatesSeeded(
      onboardingDocumentSlugs,
    );
    const folderGuideDocId = seededTemplateDocIds[FOLDER_GUIDE_SLUG];

    // create default organize
    if (folderGuideDocId) {
      const organizeService = workspace.scope.get(OrganizeService);
      const folderId = organizeService.folderTree.rootFolder.createFolder(
        I18n.t("com.myoxus.onboarding.folders.folder-name"),
        organizeService.folderTree.rootFolder.indexAt("after"),
      );
      const starterFolderNode =
        organizeService.folderTree.folderNode$(folderId).value;
      starterFolderNode?.createLink(
        "doc",
        folderGuideDocId,
        starterFolderNode.indexAt("after"),
      );
    }

    return {
      meta,
      defaultDocId:
        seededTemplateDocIds[DEFAULT_SHOWCASE_SLUG] ??
        Object.values(seededTemplateDocIds)[0],
    };
  } finally {
    dispose();
  }
}

const logger = new DebugLogger("createFirstAppData");

export async function createFirstAppData(workspacesService: WorkspacesService) {
  if (!canUseLocalWorkspaces()) return;
  if (localStorage.getItem("is-first-open") !== null) {
    return;
  }
  localStorage.setItem("is-first-open", "false");
  const { meta, defaultDocId } = await buildShowcaseWorkspace(
    workspacesService,
    "local",
    DEFAULT_WORKSPACE_NAME,
  );
  logger.info("create first workspace", defaultDocId);
  return { meta, defaultPageId: defaultDocId };
}
