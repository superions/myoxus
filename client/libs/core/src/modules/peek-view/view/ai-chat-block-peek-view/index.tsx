import { downloadSavedCopilotFile } from "@myoxus/core/editor/ai/provider/copilot-client";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { readStoredMessages } from "@myoxus/core/editor/ai/blocks/ai-chat-block/ai-chat-block";
import { StoredChatMessages } from "@myoxus/core/editor/ai/blocks/ai-chat-block/components/stored-chat-messages";
import { Scrollable } from "@myoxus/ui-facade";
import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import type { AIChatBlockModel } from "@myoxus/core/editor/ai/blocks/ai-chat-block/model/ai-chat-model";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { FetchService } from "@myoxus/core/modules/server";
import { useFramework, useService } from "@myoxus/infra";
import type { EditorHost } from "@virgultum/editor/std";
import { lazy, Suspense, useMemo, useSyncExternalStore } from "react";

const InteractiveAIChatBlockPeekView = lazy(() => import("./interactive"));

export type AIChatBlockPeekViewProps = {
  model: AIChatBlockModel;
  host: EditorHost;
};

export function AIChatBlockPeekView(props: AIChatBlockPeekViewProps) {
  const enable = useEnableAI();
  const store = props.host.store;
  const readonly = useSyncExternalStore(
    (notify) => store.readonly$.subscribe(notify),
    () => store.readonly,
  );
  return enable && !readonly ? (
    <Suspense fallback={null}>
      <InteractiveAIChatBlockPeekView {...props} />
    </Suspense>
  ) : (
    <ReadonlyAIChatBlockPeekView {...props} />
  );
}

function ReadonlyAIChatBlockPeekView({
  model,
  host,
}: AIChatBlockPeekViewProps) {
  const source = useSyncExternalStore(
    (notify) => model.props.messages$.subscribe(notify),
    () => model.props.messages$.value,
  );
  const { docDisplayConfig } = useAIChatConfig();
  const framework = useFramework();
  const peekViewService = framework.get(PeekViewService);
  const fetchService = useService(FetchService);
  const messages = useMemo(() => readStoredMessages(source), [source]);
  return (
    <Scrollable.Viewport scrollbars="y" fill>
      <StoredChatMessages
        host={host}
        messages={messages}
        readOnly
        showGeneratedFiles
        downloadSavedFile={(file, current) =>
          downloadSavedCopilotFile(fetchService.fetch, file, current)
        }
        docDisplayConfig={docDisplayConfig}
        peekViewService={peekViewService}
      />
    </Scrollable.Viewport>
  );
}
