/**
 * AIIsland — the floating AI chat button that hovers over the workspace UI.
 *
 * Provides a persistent, low-footprint access point to the AI chat feature.
 * The button is concealed through the shared facade floating-action role in
 * the following situations to avoid redundancy:
 * - The current document has a "chat" sidebar tab AND the chat tab is already
 *   active in an open sidebar.
 * - The current path is the dedicated `/chat` view.
 * - The current path includes `attachments` (attachment viewer has no AI).
 * - The current path is a Database workbench route, where floating
 *   chat would cover table-editor controls and violates the database editor
 *   surface contract.
 * - The existing workspace AI gates are not all enabled.
 *
 * On click the button opens the AI chat through the shared floating-action
 * responsive action contract. Product code supplies the two domain targets:
 * opening the document sidebar chat or navigating to `/chat`. The Facade owns
 * the Mantine breakpoint decision so this component does not carry viewport
 * hooks or hard-coded responsive thresholds.
 *
 * The island starts hidden and animates in to prevent a layout flash on mount.
 */
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { FloatingActionTrigger } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

import { IslandContainer } from "./container";
import { AIIcon } from "./icons";

/**
 * Paths on which the AI island should be hidden.
 * Entries can be exact path strings or predicate functions.
 */
const hideChat: Array<string | ((path: string) => boolean)> = [
  "/chat",
  (path) => path.includes("attachments"),
  (path) => path.includes("/databases"),
];

/**
 * Floating AI chat button component.
 *
 * Mounted once inside `<WorkspaceLayout>` and remains visible across all
 * workspace views (document editor, all docs, trash, etc.) unless the chat is
 * already open or the current path is excluded.
 */
export const AIIsland = () => {
  const t = useI18n();
  const enableAI = useEnableAI();
  // to make sure ai island is hidden first and animate in
  const [hide, setHide] = useState(true);

  const workbench = useService(WorkbenchService).workbench;
  const activeView = useLiveData(workbench.activeView$);
  const hasChatSurface = useLiveData(
    activeView.contextSurfaces$.map((surfaces) =>
      surfaces.some((surface) => surface.id === "chat"),
    ),
  );
  const activeLocation = useLiveData(activeView.location$);
  const toolLayout = useLiveData(activeView.toolLayout$);
  const contextPanelOpen = useLiveData(workbench.contextPanelOpen$);
  const hiddenByRoute = hideChat.some((item) =>
    typeof item === "string"
      ? activeLocation.pathname === item
      : item(activeLocation.pathname),
  );

  useEffect(() => {
    const hiddenByOpenContextChat =
      hasChatSurface &&
      !!contextPanelOpen &&
      toolLayout.visibleToolIds.includes("chat");
    const hide = hiddenByRoute || hiddenByOpenContextChat;
    setHide(hide);
  }, [
    contextPanelOpen,
    hasChatSurface,
    hiddenByRoute,
    toolLayout.visibleToolIds,
  ]);

  const openSidebarChat = useCallback(() => {
    if (!hasChatSurface) {
      workbench.open("/chat");
      workbench.closeContextPanel();
      return;
    }
    activeView.showTool("chat");
  }, [activeView, hasChatSurface, workbench]);

  const openWorkspaceChat = useCallback(() => {
    workbench.open("/chat");
    workbench.closeContextPanel();
  }, [workbench]);

  const responsiveAction = {
    narrow: openWorkspaceChat,
    wide: openSidebarChat,
    preferWide: hasChatSurface,
  };

  if (!enableAI || hiddenByRoute) {
    return null;
  }

  return (
    <IslandContainer concealed={hide}>
      <FloatingActionTrigger
        aria-label={t["com.myoxus.ai.chat-panel.title"]()}
        concealed={hide}
        data-myoxus-ui-role="button:icon-only:ai-island"
        data-testid="ai-island"
        responsiveAction={responsiveAction}
      >
        <AIIcon />
      </FloatingActionTrigger>
    </IslandContainer>
  );
};
