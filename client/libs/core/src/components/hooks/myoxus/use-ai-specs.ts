import { getViewManager } from "@myoxus/core/editor/manager/view";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useFramework, useServices } from "@myoxus/infra";
import { useLitPortalFactory } from "@myoxus/lit-react";
import { useConfirmModal } from "@myoxus/ui-facade";
import { useMemo } from "react";

import { useEnableAI } from "./use-enable-ai";

export const useAISpecs = () => {
  const framework = useFramework();
  const enableAI = useEnableAI();
  const { openConfirmModal, closeConfirmModal } = useConfirmModal();
  // The hook returns a fresh object; specs must not be recreated for every
  // portal update merely because the two stable modal commands were repackaged.
  const confirmModal = useMemo(
    () => ({ openConfirmModal, closeConfirmModal }),
    [openConfirmModal, closeConfirmModal],
  );
  const [reactToLit, _portals] = useLitPortalFactory();

  const { workspaceService } = useServices({
    WorkspaceService,
  });

  const isCloud = workspaceService.workspace.flavour !== "local";

  const specs = useMemo(() => {
    const manager = getViewManager()
      .config.init()
      .foundation(framework)
      .ai(enableAI, framework)
      .editorConfig(framework)
      .editorView({
        framework,
        reactToLit,
        confirmModal,
        scope: "workspace",
      })
      .cloud(framework, isCloud)
      .pdf(reactToLit)
      .database(framework)
      .linkedDoc(framework)
      .paragraph(enableAI)
      .mobile(framework)
      .electron(framework)
      .linkPreview(framework)
      .iconPicker(framework)
      .codeBlockPreview(framework).value;

    return manager.get("page");
  }, [framework, reactToLit, enableAI, isCloud, confirmModal]);

  return specs;
};
