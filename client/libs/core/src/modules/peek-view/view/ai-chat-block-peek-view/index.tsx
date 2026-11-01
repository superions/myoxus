import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { AIChatBlockPeekViewTemplate } from "@myoxus/core/editor/ai";
import type { AIChatBlockModel } from "@myoxus/core/editor/ai/blocks/ai-chat-block/model/ai-chat-model";
import { registerAIAppEffects } from "@myoxus/core/editor/ai/effects/app";
import {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { ServerService } from "@myoxus/core/modules/server";
import { useFramework } from "@myoxus/infra";
import { toReactNode, useLitPortalFactory } from "@myoxus/lit-react";
import type { EditorHost } from "@virgultum/editor/std";
import { Fragment, useMemo } from "react";

registerAIAppEffects();

export type AIChatBlockPeekViewProps = {
  model: AIChatBlockModel;
  host: EditorHost;
};

export const AIChatBlockPeekView = ({
  model,
  host,
}: AIChatBlockPeekViewProps) => {
  const [reactToLit, portals] = useLitPortalFactory();
  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const framework = useFramework();
  const serverService = framework.get(ServerService);
  const myoxusFeatureFlagService = framework.get(FeatureFlagService);
  const myoxusWorkspaceDialogService = framework.get(WorkspaceDialogService);
  const aiDraftService = framework.get(AIDraftService);
  const aiToolsConfigService = framework.get(AIToolsConfigService);
  const aiModelService = framework.get(AIModelService);

  const content = useMemo(() => {
    const template = AIChatBlockPeekViewTemplate(
      model,
      host,
      docDisplayConfig,
      searchMenuConfig,
      reasoningConfig,
      serverService,
      myoxusFeatureFlagService,
      myoxusWorkspaceDialogService,
      aiDraftService,
      aiToolsConfigService,
      aiModelService,
      reactToLit,
    );
    return toReactNode(template);
  }, [
    model,
    host,
    docDisplayConfig,
    searchMenuConfig,
    reasoningConfig,
    serverService,
    myoxusFeatureFlagService,
    myoxusWorkspaceDialogService,
    aiDraftService,
    aiToolsConfigService,
    aiModelService,
    reactToLit,
  ]);
  return (
    <>
      {content}
      {portals.map(({ id, portal }) => (
        <Fragment key={id}>{portal}</Fragment>
      ))}
    </>
  );
};
