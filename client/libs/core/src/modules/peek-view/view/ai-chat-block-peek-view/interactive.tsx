import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { AIChatBlockPeekSession } from "@myoxus/core/editor/ai/peek-view/chat-block-peek-view";
import { registerAIAppEffects } from "@myoxus/core/editor/ai/effects/app";
import { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { ServerService } from "@myoxus/core/modules/server";
import { useFramework } from "@myoxus/infra";
import { useLitPortalFactory } from "@myoxus/lit-react";
import { Box } from "@myoxus/ui-facade";
import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { AIChatBlockPeekViewProps } from "./index";

registerAIAppEffects();

const InteractiveAIChatBlockPeekView = ({
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
  const aiToolsConfigService = framework.get(AIToolsConfigService);
  const aiModelService = framework.get(AIModelService);
  const peekViewService = framework.get(PeekViewService);

  const session = useMemo(
    () =>
      new AIChatBlockPeekSession({
        blockModel: model,
        host,
        docDisplayConfig,
        searchMenuConfig,
        reasoningConfig,
        serverService,
        myoxusFeatureFlagService,
        myoxusWorkspaceDialogService,
        aiToolsConfigService,
        aiModelService,
        reactToLit,
        peekViewService,
      }),
    [
      model,
      host,
      docDisplayConfig,
      searchMenuConfig,
      reasoningConfig,
      serverService,
      myoxusFeatureFlagService,
      myoxusWorkspaceDialogService,
      aiToolsConfigService,
      aiModelService,
      reactToLit,
      peekViewService,
    ],
  );

  const anchor = useRef<HTMLDivElement>(null);
  const revision = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useLayoutEffect(() => session.connect(anchor.current!), [session]);
  useLayoutEffect(() => session.afterCommit(), [session, revision]);
  return (
    <Box ref={anchor} h="100%">
      {session.render()}
      {portals.map(({ id, portal }) => (
        <Fragment key={id}>{portal}</Fragment>
      ))}
    </Box>
  );
};

export default InteractiveAIChatBlockPeekView;
