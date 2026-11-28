import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { ChatBlockPeek } from "@myoxus/core/editor/ai/peek-view/chat-block-peek";
import { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { useFramework } from "@myoxus/infra";
import { Box } from "@myoxus/ui-facade";
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

  return (
    <Box h="100%">
      <ChatBlockPeek
        blockModel={model}
        host={host}
        docDisplayConfig={docDisplayConfig}
        searchMenuConfig={searchMenuConfig}
        reasoningConfig={reasoningConfig}
        aiToolsConfigService={aiToolsConfigService}
        aiModelService={aiModelService}
        peekViewService={peekViewService}
      />
    </Box>
  );
};

export default InteractiveAIChatBlockPeekView;
