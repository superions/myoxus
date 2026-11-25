import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { AIChatBlockPeekSession } from "@myoxus/core/editor/ai/peek-view/chat-block-peek-view";
import { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { useFramework } from "@myoxus/infra";
import { Box } from "@myoxus/ui-facade";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { AIChatBlockPeekViewProps } from "./index";

const InteractiveAIChatBlockPeekView = ({
  model,
  host,
}: AIChatBlockPeekViewProps) => {
  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const framework = useFramework();
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
        aiToolsConfigService,
        aiModelService,
        peekViewService,
      }),
    [
      model,
      host,
      docDisplayConfig,
      searchMenuConfig,
      reasoningConfig,
      aiToolsConfigService,
      aiModelService,
      peekViewService,
    ],
  );

  const revision = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useLayoutEffect(() => session.connect(), [session]);
  useLayoutEffect(() => session.afterCommit(), [session, revision]);
  return <Box h="100%">{session.render()}</Box>;
};

export default InteractiveAIChatBlockPeekView;
